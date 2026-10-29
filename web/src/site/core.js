/* Shared helpers: loading the shop, routing, page chrome, and startup (init). */

/** Resolve Bookking-managed custom domain → slug (domainMappings, status=active). */
function resolveCustomDomainSlug(host) {
  host = (host || '').toLowerCase();
  if (!host || isBookkingPlatformHost(host)) return Promise.resolve('');
  return db.collection('domainMappings').doc(host).get()
    .then(function(snap) {
      if (!snap.exists) return '';
      var d = snap.data() || {};
      if ((d.status || '') !== 'active') return '';
      return (d.slug || '').toString().toLowerCase();
    })
    .catch(function() { return ''; });
}

function ensureAnonymousAuth() {
  if (firebase.auth().currentUser) return Promise.resolve();
  return firebase.auth().signInAnonymously();
}

function formatFirebaseHttpsError(err) {
  if (!err) return 'Something went wrong. Please try again.';
  var d = err.details;
  if (typeof d === 'string' && d.trim()) return d.trim();
  var msg = (err.message && String(err.message).trim()) || '';
  if (/failed to fetch|cors|network error/i.test(msg)) {
    return 'Could not reach checkout. Please refresh and try again.';
  }
  if (msg && msg.toLowerCase() !== 'internal' && msg !== err.code) return msg;
  var code = err.code || '';
  if (code === 'functions/internal' || code === 'internal') {
    return 'Checkout failed on the server. The business may need to finish Stripe setup.';
  }
  if (code.indexOf('failed-precondition') !== -1 || code === 'functions/failed-precondition') {
    return msg || (d != null ? String(d) : 'This request could not be completed.');
  }
  if (code.indexOf('unauthenticated') !== -1 || code === 'functions/unauthenticated') {
    return 'Could not start checkout. Please refresh and try again.';
  }
  return msg || code || 'Something went wrong. Please try again.';
}

function parsePath(customHostSlug) {
  var path = (location.pathname || '').replace(/^\/+|\/+$/g, '');
  var parts = path ? path.split('/') : [];
  var host = (location.hostname || '').toLowerCase();
  var hostTenant = tenantSlugFromBookingHost(host) || (customHostSlug || '');

  var tenantSlug = '';
  var memberSlug = '';
  var page = 'home';
  var legacyMemberPath = false;
  var teamMemberRoute = false;
  var segIdx = hostTenant ? 0 : 1;

  if (hostTenant) {
    tenantSlug = hostTenant.toLowerCase();
  } else {
    tenantSlug = (parts[0] || '').toLowerCase();
  }

  var firstSeg = (parts[segIdx] || '').toLowerCase();
  if (firstSeg === 'team') {
    var teamSub = (parts[segIdx + 1] || '').toLowerCase();
    if (teamSub && !RESERVED_TENANT_PAGES[teamSub]) {
      memberSlug = teamSub;
      teamMemberRoute = true;
      page = (parts[segIdx + 2] || 'provider').toLowerCase();
      if (!page) page = 'provider';
    } else {
      page = 'team';
    }
  } else if (firstSeg && !RESERVED_TENANT_PAGES[firstSeg] && firstSeg !== tenantSlug) {
    memberSlug = firstSeg;
    legacyMemberPath = true;
    page = (parts[segIdx + 1] || 'provider').toLowerCase();
    if (!page) page = 'provider';
  } else {
    page = hostTenant ? (parts[0] || 'home').toLowerCase() : (parts[1] || 'home').toLowerCase();
    if (!page) page = 'home';
    if (page === tenantSlug) page = 'home';
  }

  var isBookPath = page === 'book';
  var isGalleryPath = page === 'gallery';
  var isShopPath = page === 'shop';
  var isAboutPath = page === 'about';
  var isTeamPath = page === 'team' && !memberSlug;
  var isHowItWorksPath = page === 'how-it-works';
  var charterTripSlug = '';
  if (page === 'charters') {
    var tripSeg = (parts[segIdx + 1] || '').toLowerCase();
    if (tripSeg && !RESERVED_TENANT_PAGES[tripSeg]) charterTripSlug = tripSeg;
  }
  var isChartersPath = page === 'charters' && !charterTripSlug;
  var isCharterDetailPath = page === 'charters' && !!charterTripSlug;
  var serviceSlugIndex;
  if (memberSlug && teamMemberRoute) {
    serviceSlugIndex = segIdx + (isBookPath ? 3 : 2);
  } else if (memberSlug) {
    serviceSlugIndex = segIdx + (isBookPath ? 2 : 1);
  } else {
    serviceSlugIndex = hostTenant ? 1 : 2;
  }
  var shopSubPath = isShopPath ? (parts[serviceSlugIndex] || '').toLowerCase() : '';
  var isShopCheckoutPath = isShopPath && shopSubPath === 'checkout';
  var serviceSlug = isBookPath && parts[serviceSlugIndex] ? String(parts[serviceSlugIndex]).toLowerCase() : '';
  if (isCharterDetailPath && !serviceSlug) serviceSlug = charterTripSlug;
  var sectionTarget = isShopPath ? 'shop' : (isAboutPath ? 'about' : '');
  return {
    tenantSlug: tenantSlug,
    memberSlug: memberSlug,
    page: page,
    serviceSlug: serviceSlug,
    charterTripSlug: charterTripSlug,
    isBookPath: isBookPath,
    isGalleryPath: isGalleryPath,
    isShopPath: isShopPath,
    isShopCheckoutPath: isShopCheckoutPath,
    isAboutPath: isAboutPath,
    isTeamPath: isTeamPath,
    isChartersPath: isChartersPath,
    isCharterDetailPath: isCharterDetailPath,
    isHowItWorksPath: isHowItWorksPath,
    isPayPath: page === 'pay',
    isProviderPath: !!memberSlug,
    legacyMemberPath: legacyMemberPath,
    sectionTarget: sectionTarget,
    isSubdomainRoute: !!hostTenant
  };
}

function tenantBaseUrl(tenant) {
  var slug = (tenant && tenant.slug ? String(tenant.slug) : '').toLowerCase();
  if (!slug) return location.origin;
  var host = (location.hostname || '').toLowerCase();
  var protocol = location.protocol || 'https:';
  var platform = tenantBookingPlatformHost(host);
  if (host === slug + '.' + platform) return location.origin;
  // Local emulator serves tenants at /{slug}/, not on a custom domain.
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return location.origin + '/' + slug;
  }
  // Bookking-managed custom domain (or any non-platform host already serving this tenant).
  if (!isBookkingPlatformHost(host)) return location.origin;
  if (host === platform || host === ('www.' + platform) || host.endsWith('.' + platform)) {
    return protocol + '//' + slug + '.' + platform;
  }
  return location.origin + '/' + slug;
}

function themeAssetId(t) {
  return (t && t.resolvedWebThemeId) || (typeof resolvedWebThemeId === 'function' ? resolvedWebThemeId(t) : '');
}

function loadThemeStylesheet(href, id) {
  if (document.getElementById(id)) return Promise.resolve();
  return new Promise(function (resolve) {
    var l = document.createElement('link');
    l.id = id;
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = function () { resolve(); };
    l.onerror = function () { resolve(); };
    document.head.appendChild(l);
  });
}

function themeAssetsReady(t) {
  var themeId = themeAssetId(t);
  var fonts = (window.BKSitePerf && window.BKSitePerf.ensureThemeFonts)
    ? window.BKSitePerf.ensureThemeFonts(themeId)
    : Promise.resolve();
  var css;
  if (window.BKSitePerf && window.BKSitePerf.ensureThemeCss) {
    css = window.BKSitePerf.ensureThemeCss(themeId);
  } else if (/studio-?12/i.test(String(themeId || ''))) {
    css = loadThemeStylesheet('/css/studio12-theme.css?v=20260915a', 'bk-theme-css-studio12');
  } else if (/blade/i.test(String(themeId || ''))) {
    css = loadThemeStylesheet('/css/blade-theme.css?v=20260915a', 'bk-theme-css-blade');
  } else if (/luxe/i.test(String(themeId || ''))) {
    css = loadThemeStylesheet('/css/luxe-theme.css?v=20260822a', 'bk-theme-css-luxe');
  } else if (/stonecut/i.test(String(themeId || ''))) {
    css = loadThemeStylesheet('/css/stonecut-theme.css?v=20260822h', 'bk-theme-css-stonecut');
  } else if (/charter/i.test(String(themeId || ''))) {
    css = loadThemeStylesheet('/css/charter-theme.css?v=20260825e', 'bk-theme-css-charter');
  } else {
    css = loadThemeStylesheet('/css/classic-theme.css?v=20260812m', 'bk-theme-css-classic');
  }
  return Promise.all([fonts, css]);
}

function tenantPageStyle(tenant, surface) {
  var s = tenantSurfaceColors(tenant, surface || 'page');
  return 'background:' + s.bg + ';color:' + s.fg;
}

function resolvedHeroImageUrl(tenant) {
  var fromTenant = tenant && tenant.heroImageUrl ? String(tenant.heroImageUrl).trim() : '';
  if (fromTenant) return fromTenant;
  var native = window.__bkNativeHeroImageUrl;
  return native ? String(native).trim() : '';
}

/** When a keyed about/contact band gets a custom fill, stamp readable ink on that band only. */
function applyKeyedAboutBandInk(el, key, bgCol, tc) {
  if (!el || !bgCol || bgCol.charAt(0) !== '#') return;
  var sid = el.getAttribute('data-bk-color-surface') || '';
  var isHomeAbout = key === 'luxe.about' || key === 'stonecut.about';
  var isAboutRole = sid === 'about' || isHomeAbout;
  if (!isAboutRole) return;
  var fg = contrastingInkHex(bgCol);
  try { el.style.setProperty('color', fg, 'important'); }
  catch (e) { el.style.color = fg; }
  if (sid === 'about' || key === 'luxe.contact' || key === 'luxe.legal' ||
      key === 'stonecut.location' || key === 'stonecut.footer' ||
      key === 'studio12.info' || key === 'studio12.footer' || key === 'studio12.teamPage' ||
      key === 'charter.footer' || key === 'charter.aboutPage') {
    el.style.setProperty('--bk-about-bg', bgCol);
    el.style.setProperty('--bk-about-fg', fg);
  }
  if (isHomeAbout) {
    el.style.setProperty('--bk-fg', fg);
    el.style.setProperty('--bk-fg-muted', rgbaFromHex(fg, 0.58));
  }
}

function clearKeyedAboutBandInk(el, key, tc) {
  if (!el) return;
  var sid = el.getAttribute('data-bk-color-surface') || '';
  var isHomeAbout = key === 'luxe.about' || key === 'stonecut.about';
  if (sid !== 'about' && !isHomeAbout) return;
  el.style.removeProperty('color');
  if (sid === 'about' || key === 'luxe.contact' || key === 'luxe.legal' ||
      key === 'stonecut.location' || key === 'stonecut.footer' ||
      key === 'studio12.info' || key === 'studio12.footer' || key === 'studio12.teamPage' ||
      key === 'charter.footer' || key === 'charter.aboutPage') {
    if (tc && tc.aboutBg) el.style.setProperty('--bk-about-bg', tc.aboutBg);
    else el.style.removeProperty('--bk-about-bg');
    if (tc && tc.aboutFg) el.style.setProperty('--bk-about-fg', tc.aboutFg);
    else el.style.removeProperty('--bk-about-fg');
  }
  if (isHomeAbout) {
    el.style.removeProperty('--bk-fg');
    el.style.removeProperty('--bk-fg-muted');
  }
}

function roleBgFromLiveCss(sid) {
  var root = document.documentElement;
  function read(name) {
    var v = '';
    try {
      v = (root.style.getPropertyValue(name) || getComputedStyle(root).getPropertyValue(name) || '').trim();
    } catch (e) { v = ''; }
    return (v && v.charAt(0) === '#') ? v : '';
  }
  if (sid === 'page' || sid === 'hero') return read('--bk-bg');
  if (sid === 'card') return read('--bk-card');
  if (sid === 'featured') return read('--bk-featured-bg');
  if (sid === 'gallery') return read('--bk-gallery-bg');
  if (sid === 'about') return read('--bk-about-bg');
  return '';
}

function applySiteSeo(t) {
  if (!t) return;
  var title = (t.seoTitle && String(t.seoTitle).trim()) || (t.displayName && String(t.displayName).trim()) || '';
  if (title) document.title = title;
  var desc = (t.seoDescription && String(t.seoDescription).trim()) || '';
  if (desc) {
    var meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', desc);
  }
}

function applySiteAnnouncement(t) {
  var existing = document.getElementById('bk-site-announcement');
  var enabled = !!(t && t.siteAnnouncementEnabled);
  var text = t && t.siteAnnouncementText ? String(t.siteAnnouncementText).trim() : '';
  if (!enabled || !text) {
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    return;
  }
  if (!existing) {
    existing = document.createElement('div');
    existing.id = 'bk-site-announcement';
    existing.setAttribute('role', 'status');
    document.body.insertBefore(existing, document.body.firstChild);
  }
  existing.textContent = text;
}

function isSheetOnlyEditKey(key) {
  if (!key) return true;
  if (key.indexOf('color:') === 0) return true;
  if (key === 'heroImage' || key === 'studio12PhilosophyImage' || key === 'studio12BookCtaImage' || key === 'classicAboutImage') return true;
  if (key.indexOf('featuredWork:') === 0 || key.indexOf('galleryImage:') === 0) return true;
  if (key.indexOf('svc:') === 0 && key.indexOf(':edit') !== -1) return true;
  if (key.indexOf('s12Process:') === 0) return true;
  if (key.indexOf('charterFaq:') === 0 && key.indexOf(':edit') !== -1) return true;
  if (key === 'charterQuote:edit') return true;
  return false;
}

function esc(s){ var d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }

/** Title-case each whitespace-separated word (matches signup.html / app). */
function titleCaseWords(raw) {
  var s = (raw || '').trim();
  if (!s) return '';
  return s.split(/\s+/).map(function(part) {
    if (!part.length) return '';
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join(' ');
}

function attachTitleCaseNameInputs(root) {
  var scope = root || document;
  var inputs = scope.querySelectorAll('input[data-key="name"]');
  for (var i = 0; i < inputs.length; i++) {
    (function(el) {
      if (el.dataset.titleCaseBound === '1') return;
      el.dataset.titleCaseBound = '1';
      el.addEventListener('blur', function() {
        var next = titleCaseWords(el.value);
        if (next !== el.value) el.value = next;
      });
    })(inputs[i]);
  }
}

/**
 * Tenant `webCopyOverrides` (`wc.*`).
 * Missing key → fallback. Explicit value (including "") → that value (empty stays blank).
 */
function webCopyOverrideText(tenant, fullKey, fallback) {
  var m = tenant && tenant.webCopyOverrides;
  if (!m || typeof m !== 'object') return fallback;
  if (!Object.prototype.hasOwnProperty.call(m, fullKey)) return fallback;
  var v = m[fullKey];
  return v != null ? String(v).trim() : '';
}

function webCopyHasExplicit(tenant, fullKey) {
  var m = tenant && tenant.webCopyOverrides;
  return !!(m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, fullKey));
}

/** Escaped inner HTML with `data-edit-key` for app quick-edit (`wc.*` → Firestore `webCopyOverrides`). */
function wcSpan(tenant, fullKey, fallback) {
  var text = webCopyOverrideText(tenant, fullKey, fallback);
  var emptyAttr = text ? '' : ' class="bk-copy-empty"';
  return '<span data-edit-key="' + esc(fullKey) + '"' + emptyAttr + '>' + esc(text) + '</span>';
}

/** Like `wcSpan` but preserves line breaks (hours, address). */
function wcSpanMultiline(tenant, fullKey, fallback) {
  var text = webCopyOverrideText(tenant, fullKey, fallback);
  var emptyAttr = text ? '' : ' class="bk-copy-empty"';
  return '<span data-edit-key="' + esc(fullKey) + '"' + emptyAttr + '>' + esc(text).replace(/\n/g, '<br>') + '</span>';
}

/** Grouped label block — key on the container so Edit outline + tap target match (Charter section labels). */
function wcLabelBlock(tenant, fullKey, fallback, className) {
  var text = webCopyOverrideText(tenant, fullKey, fallback);
  var cls = (className || 'charter-sec-label') + (text ? '' : ' bk-copy-empty');
  var emptySlot = text ? '' : ' data-bk-empty-slot="1"';
  return '<div class="' + cls + '" data-edit-key="' + esc(fullKey) + '"' + emptySlot + '>' + esc(text) + '</div>';
}

function isSiteTextBlankValue(v) {
  if (v == null) return false;
  var s = String(v);
  return s === SITE_TEXT_BLANK || s === SITE_TEXT_BLANK_LEGACY;
}

/** Map Firestore optional copy onto the tenant row; rewrite legacy `__blank__` to invisible ZWSP. */
function normalizeIncomingSiteText(v) {
  if (v == null || v === '') return '';
  if (isSiteTextBlankValue(v)) return SITE_TEXT_BLANK;
  return String(v);
}

function tenantSiteTextIsBlank(tenant, key) {
  return !!(tenant && Object.prototype.hasOwnProperty.call(tenant, key) && isSiteTextBlankValue(tenant[key]));
}

/**
 * Optional dedicated site-copy field.
 * Blank sentinel → ""; missing / legacy "" → fallback; otherwise trimmed value.
 */
function tenantSiteText(tenant, key, fallback) {
  if (tenantSiteTextIsBlank(tenant, key)) return '';
  if (!tenant || !Object.prototype.hasOwnProperty.call(tenant, key) || tenant[key] == null) {
    return fallback;
  }
  var raw = String(tenant[key]);
  if (isSiteTextBlankValue(raw)) return '';
  var v = raw.trim();
  if (!v) return fallback;
  return v;
}

/** Like tenantSiteText but runs `computeDefault` only when the field is unset (not intentionally blank). */
function tenantSiteTextOrCompute(tenant, key, computeDefault) {
  if (tenantSiteTextIsBlank(tenant, key)) return '';
  if (tenant && Object.prototype.hasOwnProperty.call(tenant, key) && tenant[key] != null) {
    var raw = String(tenant[key]);
    if (isSiteTextBlankValue(raw)) return '';
    var v = raw.trim();
    if (v) return v;
  }
  return typeof computeDefault === 'function' ? computeDefault() : String(computeDefault || '');
}

function siteTextSpan(editKey, text) {
  if (isSiteTextBlankValue(text)) text = '';
  var emptyAttr = text ? '' : ' class="bk-copy-empty"';
  return '<span data-edit-key="' + esc(editKey) + '"' + emptyAttr + '>' + esc(text) + '</span>';
}

/**
 * Like siteTextSpan, but if `text` includes a single <em>…</em> pair (Classic about defaults),
 * render real italics instead of escaped tags. Inner text stays escaped.
 */
function siteTextSpanWithInlineEm(editKey, text) {
  if (isSiteTextBlankValue(text)) text = '';
  var raw = String(text || '');
  var m = raw.match(/^(.*?)<em>([\s\S]*?)<\/em>(.*)$/i);
  if (!m) return siteTextSpan(editKey, raw);
  var emptyAttr = (m[1] + m[2] + m[3]).trim() ? '' : ' class="bk-copy-empty"';
  return '<span data-edit-key="' + esc(editKey) + '"' + emptyAttr + '>' +
    esc(m[1]) + '<em>' + esc(m[2]) + '</em>' + esc(m[3]) +
    '</span>';
}

/** Website-only service label/description; real catalog edits happen in Design → Services. */
function svcSpan(tenant, serviceId, field, displayText) {
  var sid = serviceId ? String(serviceId) : '';
  if (!sid) return esc(displayText);
  return wcSpan(tenant, 'wc.svc.' + sid + '.' + field, displayText);
}

/** Same as `svcSpan` but preserves line breaks inside the editable region. */
function svcSpanMultiline(tenant, serviceId, field, displayText) {
  var sid = serviceId ? String(serviceId) : '';
  if (!sid) return esc(displayText).replace(/\n/g, '<br>');
  return wcSpanMultiline(tenant, 'wc.svc.' + sid + '.' + field, displayText);
}

/** Whole service row/card tap → native Edit service sheet (`svc:<id>:edit`). */
function svcEditAttr(serviceId) {
  var sid = serviceId ? String(serviceId) : '';
  if (!sid) return '';
  return ' data-edit-key="svc:' + esc(sid) + ':edit" role="button" aria-label="Edit service"';
}

/** Integer pixel dimension from Firestore for hero JPEG; fallback when missing (legacy tenants). */
function tenantHeroPixelDim(v, fallback) {
  var n = Number(v);
  if (!isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** GCD-reduced positive integers for CSS `aspect-ratio` from raw pixel dimensions. */
function tenantPixelPairReduced(w, h) {
  w = Math.floor(Number(w));
  h = Math.floor(Number(h));
  if (!isFinite(w) || w < 1) w = 16;
  if (!isFinite(h) || h < 1) h = 9;
  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = b; b = a % b; a = t; }
    return a || 1;
  }
  var g = gcd(w, h);
  return { w: w / g, h: h / g };
}

/** Inline custom properties for one image box; each element sets its own --hero-ar-* scope. */
function tenantPixelAspectCssVars(w, h) {
  var ar = tenantPixelPairReduced(w, h);
  return '--hero-ar-w:' + ar.w + ';--hero-ar-h:' + ar.h + ';';
}

function tenantHeroAspectCssVars(tenant) {
  return tenantPixelAspectCssVars(tenant.heroImagePixelWidth, tenant.heroImagePixelHeight);
}

/** True on iPhone / iPod / iPad, iPadOS (MacIntel + touch), or when URL has ?maps=apple (e.g. in-app WebView). */
function clientPrefersAppleMaps() {
  if (typeof navigator === 'undefined') return false;
  try {
    if (typeof location !== 'undefined' && location.search && /[?&]maps=apple(?:&|$)/i.test(location.search)) return true;
  } catch (e) { /* ignore */ }
  var ua = navigator.userAgent || '';
  if (/iPhone|iPod|iPad/i.test(ua)) return true;
  var plat = navigator.platform || '';
  if ((plat === 'MacIntel' || plat === 'iPad') && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1) return true;
  return false;
}

/** Opens Apple Maps on Apple mobile clients; Google Maps elsewhere. */
function googleMapsSearchUrl(query) {
  var q = String(query || '').trim().replace(/\n/g, ' ');
  if (!q) return '';
  if (clientPrefersAppleMaps()) {
    return 'https://maps.apple.com/?q=' + encodeURIComponent(q);
  }
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

/** Google Maps iframe embed (address / city query). */
function googleMapsEmbedUrl(query) {
  var q = String(query || '').trim().replace(/\n/g, ' ');
  if (!q) return '';
  return 'https://www.google.com/maps?q=' + encodeURIComponent(q) + '&output=embed';
}

/** Street line + optional suite; falls back to legacy multiline `address`. */
function tenantStreetAddressText(tenant) {
  if (!tenant) return '';
  var street = tenant.contactAddress && String(tenant.contactAddress).trim() ? String(tenant.contactAddress).trim() : '';
  var suite = tenant.contactAddressSuite && String(tenant.contactAddressSuite).trim() ? String(tenant.contactAddressSuite).trim() : '';
  if (street || suite) {
    return suite ? (street ? (street + '\n' + suite) : suite) : street;
  }
  return tenant.address && String(tenant.address).trim() ? String(tenant.address).trim() : '';
}

function isBkCaptureMode() {
  return document.documentElement.classList.contains('bk-capture-mode') ||
    /(?:^|[?&])bk_capture=1(?:&|$)/.test(String(location.search || ''));
}

function telHrefFromPhone(phone) {
  if (!phone) return '';
  var digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return '';
  if (digits.length === 10) return 'tel:+1' + digits;
  if (digits.length === 11 && digits.charAt(0) === '1') return 'tel:+' + digits;
  return 'tel:+' + digits;
}

/** Guest-first SMS link (iOS/Android). Optional prefilled body. */
function smsHrefFromPhone(phone, body) {
  if (!phone) return '';
  var digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return '';
  var e164 = digits.length === 10
    ? '+1' + digits
    : (digits.length === 11 && digits.charAt(0) === '1' ? '+' + digits : '+' + digits);
  var href = 'sms:' + e164;
  var text = (body || '').toString().trim();
  if (text) href += '?body=' + encodeURIComponent(text);
  return href;
}

/** US display (xxx) xxx-xxxx; matches iOS `PhoneFormatting` / booking submit. */
function displayPhoneUS(raw) {
  var s = (raw || '').toString().trim();
  if (!s) return '';
  var hasPlus = s.charAt(0) === '+';
  var digits = s.replace(/\D/g, '');
  if (!digits) return s;
  function formatUS10(d10) {
    return '(' + d10.slice(0, 3) + ') ' + d10.slice(3, 6) + '-' + d10.slice(6, 10);
  }
  if (digits.length === 10) return formatUS10(digits);
  if (digits.length === 11 && digits.charAt(0) === '1') return formatUS10(digits.slice(1));
  if (hasPlus) return '+' + digits;
  if (digits.length >= 7) return '+' + digits;
  return s;
}

function contactPhoneDisplayEscaped(tenant) {
  return tenant.contactPhone ? esc(displayPhoneUS(tenant.contactPhone)) : '';
}

function footerPrivacyLinkHtml() {
  return ' · <a href="' + BOOK_PRIVACY_URL + '" class="book-legal-privacy" target="_blank" rel="noopener noreferrer">Privacy</a>';
}

/** One quick-edit region for © line (avoids split boxes on year / name / rights). */
function footerLegalLineHtml(tenant) {
  var y = new Date().getFullYear();
  var name = tenantSiteDisplayName(tenant, 'Studio');
  var fallback = '© ' + y + ' ' + name + '. All rights reserved.';
  return wcSpan(tenant, 'wc.footer.legalLine', fallback) + footerPrivacyLinkHtml();
}

/** In-app Design preview preserves template structure without changing the public site's page visibility. */
function isTemplatePreview() {
  try {
    if (new URLSearchParams(location.search || '').get('bk_template_preview') === '1') return true;
    if (new URLSearchParams(location.search || '').get('bk_design') === '1') return true;
    return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bkPreviewEdit);
  } catch (e) {
    return false;
  }
}

function previewWebThemeOverrideId() {
  if (!isTemplatePreview()) return '';
  // Full tenant override injected by Swift WKUserScript (iOS).
  try {
    var ov = window.__bkPreviewTenantOverride;
    if (ov && ov.webThemeId) {
      var ovId = String(ov.webThemeId).trim();
      if (ovId && BK_PREVIEW_WEB_THEME_IDS.indexOf(ovId) >= 0) return ovId;
    }
  } catch (e) {}
  // Legacy bare-theme iOS injection.
  try {
    var native = String(window.__bkPreviewThemeId || '').trim();
    if (native && BK_PREVIEW_WEB_THEME_IDS.indexOf(native) >= 0) return native;
  } catch (e) {}
  // URL param — web Design editor passes bk_web_theme=<id> on the iframe src.
  try {
    var id = String(new URLSearchParams(location.search || '').get('bk_web_theme') || '').trim();
    if (!id || BK_PREVIEW_WEB_THEME_IDS.indexOf(id) < 0) return '';
    return id;
  } catch (e) {
    return '';
  }
}

function applyPreviewThemeOverride(tenant) {
  if (!tenant) return tenant;
  applyDesignVisibilityOverride(tenant);
  var id = previewWebThemeOverrideId();
  if (!id) return tenant;
  if (isCharterPlan(tenant) || String(tenant.industry || '') === 'charters') {
    tenant.webThemeId = 'charter-v1';
    tenant.resolvedWebThemeId = 'charter-v1';
  } else if (id !== 'charter-v1') {
    tenant.webThemeId = id;
    tenant.resolvedWebThemeId = resolvedWebThemeId(tenant);
  }
  // Apply full color + style-map override from Swift-side state (iOS only — web editor
  // sends these via color-patch postMessage after bridge handshake).
  try {
    var ov = window.__bkPreviewTenantOverride;
    if (ov) {
      var colorFields = ['backgroundColor','textColor','cardSurfaceColor','primaryColor',
        'primaryColorHover','accentTextColor','featuredWorkBackgroundColor','featuredWorkTextColor',
        'galleryPageBackgroundColor','galleryPageTextColor','aboutSectionBackgroundColor',
        'aboutSectionTextColor','sidebarBackgroundColor','sidebarTextColor',
        'sidebarCloseIconColor','sidebarIconColorHome','sidebarIconColorBooking','heroSlotBg'];
      for (var i = 0; i < colorFields.length; i++) {
        var k = colorFields[i];
        if (ov[k] !== undefined && ov[k] !== '') tenant[k] = ov[k];
      }
      if (ov.webSurfaceColors !== undefined) tenant.webSurfaceColors = ov.webSurfaceColors;
      if (ov.webButtonColors !== undefined) tenant.webButtonColors = ov.webButtonColors;
      if (ov.webTextColors !== undefined) tenant.webTextColors = ov.webTextColors;
      if (ov.webTextFontSizes !== undefined) tenant.webTextFontSizes = ov.webTextFontSizes;
    }
  } catch (e) {}
  return tenant;
}

/** Design canvas draft: `bk_vis` shows page toggles before Publish. */
function applyDesignVisibilityOverride(tenant) {
  if (!tenant || !isTemplatePreview()) return;
  var raw = '';
  try {
    raw = new URLSearchParams(location.search || '').get('bk_vis') || '';
  } catch (e) { return; }
  if (!raw) return;
  raw.split(',').forEach(function (pair) {
    var bits = pair.split(':');
    var name = bits[0];
    var on = bits[1] !== '0';
    if (name === 'gallery') tenant.showGalleryPage = on;
    else if (name === 'book') tenant.showBookPage = on;
    else if (name === 'about') tenant.showAboutPage = on;
    else if (name === 'team') {
      tenant.showTeamPage = on;
      tenant.showMeetTheTeamOnHome = on;
    }
    else if (name === 'shop') tenant.shopEnabled = on;
  });
}

function tenantShowAboutPage(tenant) {
  return tenant.showAboutPage !== false;
}

function tenantShowHowItWorksPage(tenant) {
  return tenant.showHowItWorksPage !== false;
}

/** Identity name from tenant (signup / settings) — not website overrides. */
function tenantIdentityDisplayName(tenant, fallback) {
  var explicit = (tenant && tenant.displayName != null) ? String(tenant.displayName).trim() : '';
  if (explicit) return explicit;
  var biz = (tenant && tenant.businessName != null) ? String(tenant.businessName).trim() : '';
  if (biz) return biz;
  return fallback || 'Studio';
}

/**
 * Public site name: website override (`wc.site.displayName`) when set,
 * else real identity displayName / businessName.
 */
function tenantSiteDisplayName(tenant, fallback) {
  var identity = tenantIdentityDisplayName(tenant, fallback);
  var over = webCopyOverrideText(tenant, 'wc.site.displayName', '');
  if (webCopyHasExplicit(tenant, 'wc.site.displayName') && over) return over;
  return identity;
}

/**
 * Quick-edit span for the website display name.
 * Placement `styleKey` keeps independent text color; wording saves to `webCopyOverrides.wc.site.displayName`
 * (does not change identity displayName / businessName).
 */
function siteNameSpan(tenant, fallback, styleKey) {
  var key = (styleKey && String(styleKey).trim()) ? String(styleKey).trim() : 'displayName';
  return '<span data-edit-key="' + esc(key) + '" data-bk-text-field="displayName">' +
    esc(tenantSiteDisplayName(tenant, fallback)) + '</span>';
}

/**
 * Header brand: the shop name, its logo, or both, as chosen in the web editor (webHeaderBrand).
 * Without a logo it's always the name.
 */
function navBrandHtml(tenant, nameHtml) {
  var mode = tenant && (tenant.webHeaderBrand === 'logo' || tenant.webHeaderBrand === 'both') ? tenant.webHeaderBrand : 'name';
  var logo = tenant && tenant.logoUrl ? String(tenant.logoUrl) : '';
  return '<span class="bk-nav-brand" data-bk-nav-brand data-mode="' + mode + '"' + (logo ? ' data-has-logo="1"' : '') + '>' +
    (logo ? '<img class="bk-nav-logo" src="' + esc(logo) + '" alt="">' : '') +
    '<span class="bk-nav-name">' + nameHtml + '</span></span>';
}

/** When false, hours blocks are omitted on the public site (independent of contact visibility). */
function tenantShowBusinessHours(tenant) {
  return tenant.showBusinessHoursOnPage !== false;
}

function tenantBusinessHoursTrimmed(tenant) {
  return String(tenant.businessHours || '').trim();
}

/** Parse tenant `businessHoursWeekly` into one display row per day (Mon-first). */
function businessHoursWeeklyGroupedRows(tenant) {
  var w = tenant && tenant.businessHoursWeekly;
  if (!w || typeof w !== 'object') return null;
  var dayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var dayLabels = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  if (!Object.keys(w).length) return null;
  function intMin(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return Math.max(0, Math.min(Math.floor(v), 24 * 60 - 1));
    var n = parseInt(String(v), 10);
    return isNaN(n) ? 0 : Math.max(0, Math.min(n, 24 * 60 - 1));
  }
  function formatMin(m) {
    var h = Math.floor(m / 60);
    var min = m % 60;
    var d = new Date(2000, 0, 1, h, min);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function parseDay(dayMap) {
    if (!dayMap || typeof dayMap !== 'object') return { closed: true, ranges: [] };
    var closed = dayMap.closed === true;
    var ranges = Array.isArray(dayMap.ranges) ? dayMap.ranges : [];
    if (!ranges.length && dayMap.openMin != null && dayMap.closeMin != null) {
      ranges = [{ openMin: dayMap.openMin, closeMin: dayMap.closeMin }];
    }
    if (closed || !ranges.length) return { closed: true, ranges: [] };
    return {
      closed: false,
      ranges: ranges.map(function(r) {
        return { openMin: intMin(r.openMin != null ? r.openMin : r.startMin), closeMin: intMin(r.closeMin != null ? r.closeMin : r.endMin) };
      })
    };
  }
  function scheduleText(day) {
    if (day.closed || !day.ranges.length) return 'Closed';
    return day.ranges.map(function(r) {
      return formatMin(r.openMin) + ' – ' + formatMin(r.closeMin);
    }).join(', ');
  }
  return dayKeys.map(function(k, i) {
    var day = parseDay(w[k]);
    return { label: dayLabels[i], time: scheduleText(day), closed: day.closed || !day.ranges.length };
  });
}

function filterSidebarLinksForPageVisibility(tenant, links) {
  if (!Array.isArray(links)) return [];
  return links.filter(function(l) {
    if (!l || !l.target) return true;
    if (l.target === 'gallery') return tenantShowGalleryPage(tenant);
    if (l.target === 'book') {
      return tenantShowBookPage(tenant) &&
        (!isCharterTheme(tenant) || tenantShowChartersPage(tenant));
    }
    if (l.target === 'about') return tenantShowAboutPage(tenant);
    if (l.target === 'team') return tenantShowTeamPage(tenant);
    if (l.target === 'shop') return tenantShowShopPage(tenant);
    if (l.target === 'charters') return tenantShowChartersPage(tenant);
    if (l.target === 'how-it-works' || l.target === 'how') return tenantShowHowItWorksPage(tenant);
    return true;
  });
}

/** Tattoo, hair salon, barber: shared portfolio booking chrome (sidebar, themed /book). */
function isPortfolioIndustry(ind) {
  return ind === 'tattoos' || ind === 'hair' || ind === 'barber';
}

function usesThemedChrome(tenant) {
  if (isStudio12Theme(tenant) || isCharterTheme(tenant)) return false;
  return isPortfolioIndustry(tenant.industry) || isLuxeTheme(tenant) || isBladeTheme(tenant) || isStonecutTheme(tenant);
}

function bindBkFadeUp() {
  var els = document.querySelectorAll('.bk-fade-up');
  if (!els.length) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!window.IntersectionObserver || reduce) {
    for (var i = 0; i < els.length; i++) els[i].classList.add('bk-visible');
    return;
  }
  if (window.__bkFadeUpObserver) {
    window.__bkFadeUpObserver.disconnect();
  }
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('bk-visible');
      obs.unobserve(entry.target);
    });
  }, { threshold: 0.07, rootMargin: '0px 0px -24px 0px' });
  window.__bkFadeUpObserver = obs;
  for (var j = 0; j < els.length; j++) obs.observe(els[j]);
}

function list(tenant, services) {
  var base = tenantBaseUrl(tenant);
  var items = services.map(function(s){ return '<a href="'+base+'/book/'+s.slug+'" class="service-item">'+esc(s.name)+'</a>'; }).join('');
  var title = '<h1>' + siteNameSpan(tenant, 'Book an appointment') + '</h1>';
  var taglineHtml = tenant.tagline ? '<p class="tagline">' + wcSpan(tenant, 'wc.generic.tagline', tenant.tagline) + '</p>' : '';
  var header;
  if (tenant.logoUrl) {
    header = '<div class="card-header">' +
      '<img class="logo" src="'+tenant.logoUrl+'" alt="">' +
      '<div class="card-header-text">' + title + taglineHtml + '</div></div>';
  } else {
    header = title + taglineHtml;
  }
  return '<div class="card">' + header + '<ul class="service-list">'+items+'</ul></div>';
}

/** Invisible full-bleed button so hero image slots stay tappable in app Quick edit (above overlays, under nothing). */
function bkHeroImageHitButtonHtml() {
  return '<button type="button" class="bk-hero-image-hit" data-edit-key="heroImage" aria-label="Change hero image"></button>';
}

function bkHeroBandHitButtonHtml() {
  return bkColorBandHitButtonHtml();
}

function field(f, services, presel) {
  var key = (f.key||'').replace(/[^a-zA-Z0-9_]/g,'');
  var name = 'f_'+key;
  var inputId = name;
  if ((f.key||'') === 'preferredDays') inputId = name + '_select';
  var req = f.required ? ' required' : '';
  var lab = '<label for="'+inputId+'">'+esc(f.label||key)+'</label>';
  var inp = '';
  if (f.key === 'service') {
    var placeholder = !presel ? '<option value="">Select a service</option>' : '';
    var opts = (services||[]).map(function(s){
      var sel = presel && presel.id === s.id ? ' selected' : '';
      return '<option value="'+s.id+'" data-slug="'+(s.slug||'')+'" data-name="'+esc(s.name)+'"'+sel+'>'+esc(s.name)+'</option>';
    }).join('');
    inp = '<select id="'+name+'" name="'+name+'" data-key="service"'+req+'>'+placeholder+opts+'</select>';
  } else if ((f.key||'') === 'preferredDays') {
    // Client-facing multi-select rendered as a custom dropdown.
    // We write chosen days into a hidden input so existing submit logic includes it in formResponses.
    inp =
      '<div class="pref-days-dropdown" data-pref-days-dropdown>' +
        '<button type="button" id="'+inputId+'" class="pref-days-button" data-pref-days-button aria-expanded="false">' +
          '<span class="pref-days-summary" data-pref-days-summary>Preferred days</span>' +
          '<span class="pref-days-caret" aria-hidden="true">▾</span>' +
        '</button>' +
        '<div class="pref-days-menu" data-pref-days-menu role="listbox" aria-multiselectable="true">' +
          '<button type="button" class="pref-days-option" data-pref-day="Mon" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Mon</span></button>' +
          '<button type="button" class="pref-days-option" data-pref-day="Tue" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Tue</span></button>' +
          '<button type="button" class="pref-days-option" data-pref-day="Wed" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Wed</span></button>' +
          '<button type="button" class="pref-days-option" data-pref-day="Thu" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Thu</span></button>' +
          '<button type="button" class="pref-days-option" data-pref-day="Fri" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Fri</span></button>' +
          '<button type="button" class="pref-days-option" data-pref-day="Sat" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Sat</span></button>' +
          '<button type="button" class="pref-days-option" data-pref-day="Sun" role="option" aria-selected="false"><span class="pref-days-check">✓</span><span>Sun</span></button>' +
        '</div>' +
        '<input type="hidden" id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'" value="" data-preferred-days-hidden />' +
      '</div>';
  } else if ((f.key||'') === 'preferredTime' || (f.key||'') === 'preferredTimeOfDay') {
    // Backwards-compatible override:
    // Some tenants may still have old schema using preferredTimeOfDay as text.
    // Force dropdown UI for both keys, independent of the stored f.type.
    var ptPlaceholder = esc(f.placeholder || f.label || 'Preferred time of day');
    inp =
      '<select id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'"'+req+'>' +
        '<option value="">'+ptPlaceholder+'</option>' +
        '<option value="Morning">Morning</option>' +
        '<option value="Afternoon">Afternoon</option>' +
        '<option value="Night">Night</option>' +
        '<option value="Flexible">Flexible</option>' +
      '</select>';
  } else if (f.type === 'select') {
    var firstOpt = '<option value="">'+esc(f.placeholder || ('Select ' + (f.label || f.key)))+'</option>';
    var oo = (f.options||[]).map(function(o){ return '<option value="'+esc(o)+'">'+esc(o)+'</option>'; }).join('');
    inp = '<select id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'"'+req+'>'+firstOpt+oo+'</select>';
  } else if (f.type === 'boolean') {
    inp = '<select id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'"'+req+'> <option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>';
  } else if ((f.key||'') === 'referenceImages') {
    inp = ''
      + '<div class="upload-drop" data-reference-images-drop tabindex="0" role="button" aria-label="Upload reference images or PDFs">'
      +   '<div class="upload-drop-inner">'
      +     '<p class="upload-drop-title">Drop photos or PDFs here</p>'
      +     '<p class="upload-drop-sub">or click to choose files (multiple allowed)</p>'
      +   '</div>'
      +   '<div class="upload-drop-filelist" data-upload-filelist></div>'
      +   '<input type="file" accept="image/*,application/pdf" multiple id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'" data-type="file" class="upload-drop-input">'
      + '</div>';
  } else if (f.type === 'file') {
    inp = '<input type="file" accept="image/*,application/pdf" multiple id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'" data-type="file">';
  } else if (f.type === 'textarea') {
    inp = '<textarea id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'" placeholder="'+esc(f.placeholder || f.label || key)+'"'+req+'></textarea>';
  } else {
    var typ = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
    inp = '<input type="'+typ+'" id="'+name+'" name="'+name+'" data-key="'+esc(f.key)+'" placeholder="'+esc(f.placeholder || f.label || key)+'"'+req+bookingNameFieldAttrs(f)+'>';
  }
  return lab + inp;
}

function splitProjectFieldsForMobileWizard(projectFields) {
  var primary = null;
  var optional = [];
  for (var i = 0; i < projectFields.length; i++) {
    var f = projectFields[i];
    if (!primary && f.type === 'select' && (f.options || []).length) {
      primary = f;
    } else {
      optional.push(f);
    }
  }
  if (!primary) {
    return { primary: null, optional: projectFields, useMobileSplit: false };
  }
  return { primary: primary, optional: optional, useMobileSplit: true };
}

function tenantClientSmsActive(tenant) {
  return !!(tenant && tenant.smsEnabled === true &&
    String(tenant.smsStatus || '').toLowerCase() === 'active');
}

function ensurePhoneInSmsConsentBox(fm, block) {
  var phoneWrap = block.querySelector('.booking-sms-consent-phone');
  if (!phoneWrap) {
    phoneWrap = document.createElement('div');
    phoneWrap.className = 'booking-sms-consent-phone';
    block.insertBefore(phoneWrap, block.firstChild);
  }
  var phoneField = fm.querySelector('[data-key="phone"]');
  if (phoneField && !phoneWrap.contains(phoneField)) {
    var labelEl = null;
    if (phoneField.id) {
      labelEl = fm.querySelector('label[for="' + phoneField.id + '"]');
    }
    if (labelEl && labelEl.parentNode) {
      labelEl.className = 'booking-sms-consent-phone-label';
      phoneWrap.appendChild(labelEl);
    } else {
      var meta = formSchemaPhoneMeta(fm);
      phoneWrap.innerHTML = '<label class="booking-sms-consent-phone-label" for="' +
        esc(phoneField.id || 'f_phone') + '">' + esc(meta.label) + '</label>';
    }
    phoneField.classList.add('booking-sms-consent-phone-input');
    if (!phoneField.classList.contains('field-input')) phoneField.classList.add('field-input');
    phoneWrap.appendChild(phoneField);
    return phoneField;
  }
  if (!phoneField) {
    var metaNew = formSchemaPhoneMeta(fm);
    var inputId = 'f_phone';
    phoneWrap.innerHTML =
      '<label class="booking-sms-consent-phone-label" for="' + esc(inputId) + '">' + esc(metaNew.label) + '</label>' +
      '<input class="field-input booking-sms-consent-phone-input" type="tel" id="' + esc(inputId) +
      '" name="' + esc(inputId) + '" data-key="phone" data-field-label="' + esc(metaNew.label) +
      '" placeholder="' + esc(metaNew.placeholder) + '" autocomplete="tel"' +
      (metaNew.required ? ' required' : '') + '>';
    return phoneWrap.querySelector('[data-key="phone"]');
  }
  return phoneField;
}

function form(tenant, services, presel, provider) {
  var artistHtml = '';
  if (isTeamPlan(tenant) && tenant._bookProviders && tenant._bookProviders.length) {
    artistHtml = bookingArtistFieldHtml(
      tenant._bookProviders,
      provider,
      tenant._assignmentPreference,
      tenant.industry
    );
  }
  var schema = tenant.formSchema || [];
  var useSchema = Array.isArray(schema) && schema.length > 0;
  var fields = useSchema ? schema : [
    {key:'name',label:'Full Name',type:'text',required:true},
    {key:'email',label:'Email',type:'email',required:true},
    {key:'phone',label:'Phone',type:'phone',required:false},
    {key:'service',label:'Service',type:'select',required:true},
    {key:'preferredTime',label:'Preferred Time',type:'text',required:false},
    {key:'notes',label:'Notes',type:'textarea',required:false}
  ];
  if (!fields.some(function(x){ return x.key === 'service'; })) {
    fields = [{key:'service',label:'Service',type:'select',required:true}].concat(fields);
  }
  var html = fields.map(function(f){
    if (f.key === 'service') return field({key:'service',label:'Service',type:'select',required:true,options:null}, services, presel);
    return field(f, services, presel);
  }).join('');

  var contact = '';
  if (!isLuxeTheme(tenant) && !isBladeTheme(tenant) && !isClassicTheme(tenant) && !isStonecutTheme(tenant)) {
    if ((tenant.showContactOnPage !== false) && (tenant.contactPhone || tenant.contactEmail)) {
      var formPh = telHrefFromPhone(tenant.contactPhone);
      var formPhonePart = tenant.contactPhone
        ? ('📞 ' + (formPh ? '<a href="' + esc(formPh) + '">' + contactPhoneDisplayEscaped(tenant) + '</a>' : contactPhoneDisplayEscaped(tenant)))
        : '';
      var formEm = tenant.contactEmail ? String(tenant.contactEmail).trim() : '';
      var formMailPart = formEm ? ('✉️ <a href="mailto:' + esc(formEm) + '">' + esc(tenant.contactEmail) + '</a>') : '';
      contact = '<p class="tagline">' + [formPhonePart, formMailPart].filter(Boolean).join(' ') + '</p>';
    }
  }

  var bookingPageHeaderHtml = brandedBookingPageHeaderHtml(tenant, provider);

  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';

  var nav = isCharterTheme(tenant)
    ? charterNavHtml(tenant, 'book')
    : (isStudio12Theme(tenant)
    ? studio12NavHtml(tenant)
    : (isBladeTheme(tenant)
      ? bladeNavHtml(tenant, base + '/home')
      : (isLuxeTheme(tenant)
        ? luxeChromeNavHtml(tenant, 'light')
        : (isStonecutTheme(tenant) ? stonecutNavHtml(tenant) : tattooNavHtml(tenant)))));

  var sidebar = isCharterTheme(tenant)
    ? ''
    : (isStudio12Theme(tenant)
    ? studio12SidebarHtml(tenant)
    : ('<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>'));

  var bookPageStyle = (isStudio12Theme(tenant) || isBladeTheme(tenant) || isLuxeTheme(tenant) || isStonecutTheme(tenant) || isCharterTheme(tenant) || isPortfolioIndustry(tenant.industry))
    ? tenantPageStyle(tenant, 'page')
    : tattooSiteThemeInlineStyle(tenant);
  var wrapClass = isCharterTheme(tenant)
    ? 'charter-page'
    : (isStonecutTheme(tenant)
    ? 'stonecut-page'
    : ('tattoo-page' + (isStudio12Theme(tenant) ? ' studio12-page studio12-sub' : '') + (isBladeTheme(tenant) ? ' blade-page blade-page--sub' : '') + (isLuxeTheme(tenant) ? ' luxe-page luxe-page--sub' : '') + (isClassicTheme(tenant) && !isStudio12Theme(tenant) ? ' classic-home' : '')));
  var bookCardBg = pickTenantHex(tenant.bookingFormCardBackgroundColor, tenantColors(tenant).card);
  var bookSiteFooter = '';
  if (isCharterTheme(tenant)) bookSiteFooter = charterFooterHtml(tenant);
  else if (isStudio12Theme(tenant)) bookSiteFooter = studio12SiteFooterHtml(tenant);
  else if (isStonecutTheme(tenant)) bookSiteFooter = stonecutSiteFooterHtml(tenant);
  else if (isBladeTheme(tenant)) bookSiteFooter = bladeSiteFooterHtml(tenant);
  else if (isLuxeTheme(tenant)) bookSiteFooter = luxeContactSectionHtml(tenant);
  else if (isClassicTheme(tenant)) bookSiteFooter = classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio'));
  if (!bookSiteFooter) bookSiteFooter = minimalBookLegalFooterHtml(tenant);
  if (usesCalendarBookingForm(tenant)) {
    var calWizard = formCalendarWizardHtml(tenant, fields, services, presel, provider);
    var calVars = guidedBookingInlineStyle(tenant);
    var calInner =
      bookingPageHeaderHtml +
      '<div class="booking-cal">' +
        '<div class="booking-cal-step-labels">' + calWizard.labelsHtml + '</div>' +
        '<form id="book-form" class="booking-form booking-form--calendar" data-cal-wizard-form data-cal-confirm-step="' + calWizard.confirmStep + '">' +
          '<input type="hidden" data-key="service" value="' + esc(calWizard.initService) + '" data-name="' + esc(calWizard.initServiceName) + '" data-slug="' + esc(calWizard.initServiceSlug) + '" required>' +
          '<input type="hidden" data-key="preferredDays" value="">' +
          '<input type="hidden" data-key="preferredTime" value="">' +
          '<input type="hidden" data-cal-member-slug value="' + esc(calWizard.preStaff) + '">' +
          '<input type="hidden" data-cal-member-name value="' + esc(calWizard.preStaffName) + '">' +
          calWizard.html +
          '<div class="booking-cal-actions">' +
            '<p id="form-error" class="error" style="display:none"></p>' +
            '<button type="button" class="booking-cal-back" data-cal-back hidden>← Back</button>' +
            '<button type="button" class="booking-cal-next booking-submit" data-cal-next>Continue</button>' +
            bookingSubmitButtonHtml(tenant, ' data-cal-submit hidden') +
          '</div>' +
        '</form>' +
      '</div>';
    return '' +
      bookingPageWrapOpenTag(tenant, wrapClass) +
        nav +
        bookingPageBandOpenTag(tenant, bookPageStyle) +
        bkColorBandInnerWrap('<div class="booking-shell booking-shell--calendar"' + (calVars ? ' style="' + calVars + '"' : '') + '>' +
          calInner +
        '</div>') +
        '</div>' +
        bookSiteFooter +
        sidebar +
      '</div>';
  }
  if (usesGuidedBookingForm(tenant)) {
    var guidedWizard = formGuidedWizardPanelsHtml(fields, services, presel);
    var guidedPanelsHtml = guidedWizard.html;
    var guidedVars = guidedBookingInlineStyle(tenant);
    var orderedProj = guidedWizardOrderedFields(fields).project;
    var mobileProj = orderedProj.length ? formGuidedProjectMobileHtml(orderedProj, services, presel) : { useMobileSplit: false };
    var projFieldsEnc = mobileProj.useMobileSplit ? encodeURIComponent(JSON.stringify(orderedProj)) : '';
    var formSchemaEnc = encodeURIComponent(JSON.stringify(fields));
    var mobileFormAttrs = mobileProj.useMobileSplit
      ? ' data-guided-mobile-project="1" data-guided-project-fields-encoded="' + projFieldsEnc + '"'
      : '';
    var guidedFormSchemaAttr = ' data-guided-form-schema-encoded="' + formSchemaEnc + '"';
    var guidedInner =
      bookingPageHeaderHtml +
      '<div class="booking-guided booking-guided--wizard booking-guided--steps-first">' +
        guidedWizardPhaseChromeHtml(tenant) +
        '<form id="book-form" class="booking-form booking-form--guided" data-guided-wizard-form data-guided-confirm-step="' + guidedWizard.confirmStep + '"' + mobileFormAttrs + guidedFormSchemaAttr + '>' +
          (artistHtml ? '<div class="bk-book-artist-wrap">' + artistHtml + '</div>' : '') +
          guidedPanelsHtml +
          (mobileProj.useMobileSplit ? guidedFieldSheetHtml() : '') +
          '<div class="booking-guided-bottom booking-guided-wizard-footer">' +
            '<p id="form-error" class="error" style="display:none"></p>' +
            '<button type="button" class="booking-guided-link-back" data-guided-back hidden>← Back</button>' +
            '<div class="booking-guided-wizard-actions">' +
              '<button type="button" class="booking-guided-btn-skip" data-guided-skip hidden>Skip — I’m good</button>' +
              '<button type="button" class="booking-guided-btn-next" data-guided-next>Continue</button>' +
              bookingSubmitButtonHtml(tenant, ' data-guided-submit hidden') +
            '</div>' +
            '<p class="booking-guided-deposit-note" data-guided-deposit-note hidden>No payment required — we\u2019ll confirm by message.</p>' +
          '</div>' +
        '</form>' +
      '</div>';
    return '' +
      bookingPageWrapOpenTag(tenant, wrapClass) +
        nav +
        bookingPageBandOpenTag(tenant, bookPageStyle) +
        bkColorBandInnerWrap('<div class="booking-shell booking-shell--guided"' + (guidedVars ? ' style="' + guidedVars + '"' : '') + '>' +
          guidedInner +
        '</div>') +
        '</div>' +
        bookSiteFooter +
        sidebar +
      '</div>';
  }
  var bookCardInner = contact +
          '<form id="book-form" class="booking-form">' +
            (artistHtml ? '<div class="bk-book-artist-wrap">' + artistHtml + '</div>' : '') +
            html +
            '<p id="form-error" class="error" style="display:none"></p>' +
            bookingSubmitButtonHtml(tenant, '') +
          '</form>';
  return '' +
    bookingPageWrapOpenTag(tenant, wrapClass) +
      nav +
      bookingPageBandOpenTag(tenant, bookPageStyle) +
      bkColorBandInnerWrap('<div class="booking-shell">' +
        bookingPageHeaderHtml +
        bookingCardOpenTag(tenant) +
        bkColorBandInnerWrap(bookCardInner) +
        '</div>' +
      '</div>') +
      '</div>' +
      bookSiteFooter +
      sidebar +
    '</div>';
}

function err(m){ return '<div class="card"><h1>Oops</h1><p class="error">'+esc(m)+'</p></div>'; }

/** Matches `WebTheme` in the app; invalid or missing ids fall back per industry / plan. */
function resolvedWebThemeId(tenant) {
  var stored = String((tenant && tenant.webThemeId) || '').trim();
  if (isCharterPlan(tenant) || String((tenant && tenant.industry) || '') === 'charters' || stored === 'charter-v1') {
    return 'charter-v1';
  }
  var ind = String(tenant.industry || '').trim();
  var universal = ['luxe-v1', 'blade-v1', 'stonecut-v1', 'studio-12-v1'];
  if (stored && universal.indexOf(stored) >= 0) return stored;
  var map = {
    'hair': ['hair-salon-v1'],
    'barber': ['barber-shop-v1'],
    'tattoos': ['tattoo-studio-v1'],
    'nails': ['nail-salon-v1'],
    'custom': ['custom-standard']
  };
  var list = map[ind] || ['custom-standard'];
  if (stored && list.indexOf(stored) >= 0) return stored;
  return list[0];
}

function mapLoadedTenant(id, data, slug) {
      var row = { id: id, slug: data.slug || slug, displayName: data.displayName, businessName: data.businessName || '', logoUrl: data.logoUrl, tagline: data.tagline,
        canonicalDomain: (data.canonicalDomain || '').toString().trim().toLowerCase(),
        smsEnabled: data.smsEnabled === true,
        smsStatus: (data.smsStatus || '').toString(),
        smsPhoneNumber: (data.smsPhoneNumber || '').toString(),
        showCharterContactCaptain: data.showCharterContactCaptain === true,
        backgroundColor: data.backgroundColor, cardSurfaceColor: data.cardSurfaceColor, textColor: data.textColor,
        primaryColor: data.primaryColor, primaryColorHover: data.primaryColorHover || '',
        formSchema: data.formSchema, showContactOnPage: data.showContactOnPage,
        contactPhone: data.contactPhone, contactEmail: data.contactEmail, isActive: data.isActive,
        industry: data.industry || '', industryCustomLabel: data.industryCustomLabel || '', heroImageUrl: data.heroImageUrl || '',
        timeZone: (data.timeZone || (data.availability && data.availability.timeZone) || 'America/New_York').toString(),
        heroImagePixelWidth: tenantHeroPixelDim(data.heroImagePixelWidth, 16),
        heroImagePixelHeight: tenantHeroPixelDim(data.heroImagePixelHeight, 9),
        galleryImages: data.galleryImages || [], galleryGridLayout: data.galleryGridLayout || '3x1',
        galleryLayoutStyle: data.galleryLayoutStyle,
        aboutText: data.aboutText || '',
        reviews: data.reviews || [], address: data.address || '', contactAddress: data.contactAddress || '', contactAddressSuite: data.contactAddressSuite || '', serviceArea: data.serviceArea || '', businessHours: data.businessHours || '', businessHoursWeekly: data.businessHoursWeekly || null, onlineBookableWeekly: data.onlineBookableWeekly || null, onlineSlotsConfigured: data.onlineSlotsConfigured === true, onlineSlotStepMinutes: (typeof data.onlineSlotStepMinutes === 'number' ? data.onlineSlotStepMinutes : 30), onlineSlotPatterns: Array.isArray(data.onlineSlotPatterns) ? data.onlineSlotPatterns : [], blockedDates: Array.isArray(data.blockedDates) ? data.blockedDates : [], blockedTimeRanges: Array.isArray(data.blockedTimeRanges) ? data.blockedTimeRanges : [], showBusinessHoursOnPage: data.showBusinessHoursOnPage !== false, instagramHandle: data.instagramHandle || '',
        mapEmbedLat: (typeof data.mapEmbedLat === 'number' && !isNaN(data.mapEmbedLat)) ? data.mapEmbedLat : null,
        mapEmbedLng: (typeof data.mapEmbedLng === 'number' && !isNaN(data.mapEmbedLng)) ? data.mapEmbedLng : null,
        mapCaptureImageUrl: data.mapCaptureImageUrl || '',
        sidebarLinks: data.sidebarLinks || [],
        sidebarBackgroundColor: data.sidebarBackgroundColor || '',
        sidebarTextColor: data.sidebarTextColor || '',
        sidebarCloseIconColor: data.sidebarCloseIconColor || '',
        sidebarIconColorHome: data.sidebarIconColorHome || '',
        sidebarIconColorBooking: data.sidebarIconColorBooking || '',
        galleryCategories: data.galleryCategories || [],
        featuredWorkBackgroundColor: data.featuredWorkBackgroundColor || '',
        featuredWorkTextColor: data.featuredWorkTextColor || '',
        bookingFormCardBackgroundColor: data.bookingFormCardBackgroundColor || '',
        galleryPageBackgroundColor: data.galleryPageBackgroundColor || '',
        galleryPageTextColor: data.galleryPageTextColor || '',
        aboutSectionBackgroundColor: data.aboutSectionBackgroundColor || '',
        aboutSectionTextColor: data.aboutSectionTextColor || '',
        headlineFont: data.headlineFont || '',
        heroFont: data.heroFont || '',
        webThemeId: data.webThemeId || '',
        webTextColors: coerceStyleMap(data.webTextColors),
        webTextFontSizes: coerceStyleMap(data.webTextFontSizes),
        webSurfaceColors: coerceStyleMap(data.webSurfaceColors),
        webButtonColors: coerceStyleMap(data.webButtonColors),
        webSectionLayouts: coerceStyleMap(data.webSectionLayouts),
        webPage: data.webPage && typeof data.webPage === 'object' ? data.webPage : {},
        webBlocks: data.webBlocks && typeof data.webBlocks === 'object' ? data.webBlocks : {},
        webHeaderBrand: (data.webHeaderBrand || '').toString(),
        webTabIcon: (data.webTabIcon || '').toString(),
        webFooter: data.webFooter && typeof data.webFooter === 'object' ? data.webFooter : {},
        bookingFormStyleId: data.bookingFormStyleId || '',
        // Prefer calendar when either field says so (see bookingModeResolved).
        bookingMode: (function() {
          var plan = String(data.subscriptionPlan || '').toLowerCase();
          if (plan === 'charter' || plan === 'charters' || String(data.industry || '') === 'charters') {
            return 'calendar_slots';
          }
          var w = data.workflow && data.workflow.bookingMode;
          var t = data.bookingMode;
          var cal = function(v) {
            var m = String(v || '').trim().toLowerCase();
            return m === 'calendar_slots' || m === 'calendar' || m === 'slots'
              || m === 'slot_booking' || m === 'online_booking' || m === 'online';
          };
          if (cal(w) || cal(t)) return 'calendar_slots';
          return w || t || '';
        })(),
        workflow: data.workflow || null,
        guidedStepTitles: data.guidedStepTitles || {},
        guidedStepOrder: data.guidedStepOrder || [],
        luxeHeroTagline: normalizeIncomingSiteText(data.luxeHeroTagline),
        luxePromoHeadline: normalizeIncomingSiteText(data.luxePromoHeadline),
        bladeHeroTagline: normalizeIncomingSiteText(data.bladeHeroTagline),
        bladeHeroDescription: normalizeIncomingSiteText(data.bladeHeroDescription),
        heroTagline: normalizeIncomingSiteText(data.heroTagline),
        heroSubtitle: normalizeIncomingSiteText(data.heroSubtitle),
        studio12PhilosophyImageUrl: data.studio12PhilosophyImageUrl || '',
        studio12PhilosophyImagePixelWidth: tenantHeroPixelDim(data.studio12PhilosophyImagePixelWidth, 16),
        studio12PhilosophyImagePixelHeight: tenantHeroPixelDim(data.studio12PhilosophyImagePixelHeight, 9),
        studio12PhilosophyHeadline: data.studio12PhilosophyHeadline || '',
        studio12PhilosophyHeadLine1: normalizeIncomingSiteText(data.studio12PhilosophyHeadLine1),
        studio12PhilosophyHeadLine2: normalizeIncomingSiteText(data.studio12PhilosophyHeadLine2),
        studio12PhilosophyHeadItalic: normalizeIncomingSiteText(data.studio12PhilosophyHeadItalic),
        studio12BookCtaHeadline: data.studio12BookCtaHeadline || '',
        studio12BookCtaLine1: normalizeIncomingSiteText(data.studio12BookCtaLine1),
        studio12BookCtaItalic: normalizeIncomingSiteText(data.studio12BookCtaItalic),
        studio12BookCtaBody: normalizeIncomingSiteText(data.studio12BookCtaBody),
        studio12BookCtaImageUrl: data.studio12BookCtaImageUrl || '',
        studio12BookCtaImagePixelWidth: tenantHeroPixelDim(data.studio12BookCtaImagePixelWidth, 16),
        studio12BookCtaImagePixelHeight: tenantHeroPixelDim(data.studio12BookCtaImagePixelHeight, 9),
        studio12ProcessSteps: data.studio12ProcessSteps || [],
        charterFaqs: Array.isArray(data.charterFaqs) ? data.charterFaqs : [],
        charterBoats: Array.isArray(data.charterBoats) ? data.charterBoats : [],
        studio12HeroEyebrow: normalizeIncomingSiteText(data.studio12HeroEyebrow),
        studio12HeroHeadline: data.studio12HeroHeadline || '',
        studio12HeroLine1: normalizeIncomingSiteText(data.studio12HeroLine1),
        studio12HeroLine2: normalizeIncomingSiteText(data.studio12HeroLine2),
        studio12ShowServicesSection: data.studio12ShowServicesSection !== false,
        studio12ShowProcessSection: data.studio12ShowProcessSection !== false,
        showGalleryPage: data.showGalleryPage !== false,
        showBookPage: data.showBookPage !== false,
        showAboutPage: data.showAboutPage !== false,
        showChartersPage: data.showChartersPage !== false,
        showHowItWorksPage: data.showHowItWorksPage !== false,
        showTeamPage: data.showTeamPage !== false,
        showMeetTheTeamOnHome: data.showMeetTheTeamOnHome !== false,
        shopEnabled: data.shopEnabled || false,
        shopPickupEnabled: data.shopPickupEnabled !== false,
        shopShowPickupAddressOnCheckout: data.shopShowPickupAddressOnCheckout !== false,
        shopShippingEnabled: data.shopShippingEnabled === true,
        shopShipFrom: (data.shopShipFrom && typeof data.shopShipFrom === 'object') ? data.shopShipFrom : null,
        shopDefaultParcel: (data.shopDefaultParcel && typeof data.shopDefaultParcel === 'object') ? data.shopDefaultParcel : null,
        subscriptionPlan: (data.subscriptionPlan || 'solo').toString(),
        classicFeaturedWorkEyebrow: normalizeIncomingSiteText(data.classicFeaturedWorkEyebrow),
        classicFeaturedWorkHeading: normalizeIncomingSiteText(data.classicFeaturedWorkHeading),
        classicFeaturedWorkSub: normalizeIncomingSiteText(data.classicFeaturedWorkSub),
        classicFeaturedWorkEmpty: normalizeIncomingSiteText(data.classicFeaturedWorkEmpty),
        classicServicesEyebrow: normalizeIncomingSiteText(data.classicServicesEyebrow),
        classicServicesHeading: normalizeIncomingSiteText(data.classicServicesHeading),
        classicServicesExpandableCard: data.classicServicesExpandableCard === true,
        classicAboutEyebrow: normalizeIncomingSiteText(data.classicAboutEyebrow),
        classicAboutHeading: normalizeIncomingSiteText(data.classicAboutHeading),
        classicAboutImageUrl: data.classicAboutImageUrl || '',
        classicAboutImagePixelWidth: tenantHeroPixelDim(data.classicAboutImagePixelWidth, 16),
        classicAboutImagePixelHeight: tenantHeroPixelDim(data.classicAboutImagePixelHeight, 9),
        luxeFeaturedWorkEyebrow: normalizeIncomingSiteText(data.luxeFeaturedWorkEyebrow),
        luxeFeaturedWorkHeading: normalizeIncomingSiteText(data.luxeFeaturedWorkHeading),
        luxeShowFeaturedWorkStrip: data.luxeShowFeaturedWorkStrip !== false,
        luxeHomeServicesEyebrow: normalizeIncomingSiteText(data.luxeHomeServicesEyebrow),
        luxeHomeServicesHeading: normalizeIncomingSiteText(data.luxeHomeServicesHeading),
        luxeShowHomeServicesSection: data.luxeShowHomeServicesSection === true,
        luxeHomeServicesExpandableCard: data.luxeHomeServicesExpandableCard === true,
        webCopyOverrides: (function() {
          var o = data.webCopyOverrides;
          if (!o || typeof o !== 'object') return {};
          var out = {};
          for (var wk in o) {
            if (!Object.prototype.hasOwnProperty.call(o, wk)) continue;
            if (wk.indexOf('wc.') !== 0) continue;
            var wv = o[wk];
            // Keep empty strings — some slots (e.g. wc.stonecut.heroIndustry) use "" to mean hide.
            if (wv != null) out[wk] = String(wv).trim();
          }
          return out;
        })() };
      if (Object.prototype.hasOwnProperty.call(data, 'featuredWorkImages')) {
        row.featuredWorkImages = data.featuredWorkImages || [];
      }
      row.resolvedWebThemeId = resolvedWebThemeId(row);
      return row;
}

function loadTenant(slug) {
  slug = (slug || '').toString().trim().toLowerCase();
  if (!slug) return Promise.resolve(null);
  function withNativeHero(row) {
    if (!row) return row;
    if (!(row.heroImageUrl || '').trim() && window.__bkNativeHeroImageUrl) {
      row.heroImageUrl = String(window.__bkNativeHeroImageUrl).trim();
    }
    return row;
  }
  return db.collection('publicSites').doc(slug).get()
    .then(function(doc) {
      if (doc.exists) {
        var data = doc.data() || {};
        var tid = (data.tenantId || '').toString();
        if (!tid) return null;
        return withNativeHero(mapLoadedTenant(tid, data, slug));
      }
      // Fallback until publicSites is backfilled. Fails closed once tenant reads are locked.
      return db.collection('tenants').where('slug','==',slug).limit(1).get()
        .then(function(snap) {
          if (snap.empty) return null;
          var d = snap.docs[0];
          return withNativeHero(mapLoadedTenant(d.id, d.data() || {}, slug));
        })
        .catch(function() { return null; });
    });
}

/** Light portfolio themes: accent drawer matches primary CTA (BOOK NOW). */
function usesAccentSidebarDrawer(tenant) {
  return isCharterTheme(tenant) ||
    (isClassicTheme(tenant) && !isStudio12Theme(tenant)) ||
    isStudio12Theme(tenant) || isLuxeTheme(tenant);
}

function sidebarLinksHtml(tenant, base, bookUrl) {
  var galleryUrl = base + '/gallery';
  var links = tenant.sidebarLinks;
  if (!Array.isArray(links)) links = [];
  if (!links.length) {
    if (isCharterTheme(tenant)) {
      links = [{ label: 'Home', type: 'internal', target: 'home' }];
      if (tenantShowChartersPage(tenant)) links.push({ label: 'Charters', type: 'internal', target: 'charters' });
      if (tenantShowHowItWorksPage(tenant)) links.push({ label: 'How it works', type: 'internal', target: 'how-it-works' });
      if (tenantShowShopPage(tenant)) links.push({ label: 'Shop', type: 'internal', target: 'shop' });
      if (tenantShowAboutPage(tenant)) links.push({ label: 'About', type: 'internal', target: 'about' });
      if (tenantShowBookPage(tenant) && tenantShowChartersPage(tenant)) links.push({ label: 'Book now', type: 'internal', target: 'charters' });
    } else {
    links = [{ label: 'Home', type: 'internal', target: 'home' }];
    if (tenantShowGalleryPage(tenant)) links.push({ label: 'Gallery', type: 'internal', target: 'gallery' });
    if (tenantShowTeamPage(tenant)) links.push({ label: 'Team', type: 'internal', target: 'team' });
    if (tenantShowBookPage(tenant)) links.push({ label: 'Book', type: 'internal', target: 'book' });
    if (tenantShowShopPage(tenant)) links.push({ label: 'Shop', type: 'internal', target: 'shop' });
    if (tenantShowAboutPage(tenant)) links.push({ label: 'About', type: 'internal', target: 'about' });
    }
  } else {
    links = links.slice();
    if (tenantShowGalleryPage(tenant) && !links.some(function(l){ return l && l.target === 'gallery'; })) {
      var insertAt = 0;
      for (var i = 0; i < links.length; i++) {
        if (links[i] && links[i].target === 'home') { insertAt = i + 1; break; }
      }
      links.splice(insertAt, 0, { label: 'Gallery', type: 'internal', target: 'gallery' });
    }
    links = filterSidebarLinksForPageVisibility(tenant, links);
  }
  return links.map(function(l, linkIndex) {
    var href;
    if (l.type === 'external' && l.url) {
      href = l.url;
    } else if (l.target === 'book') {
      href = (isCharterTheme(tenant) || isCharterPlan(tenant)) ? (base + '/charters') : bookUrl;
    } else if (l.target === 'gallery') {
      href = galleryUrl;
    } else if (l.target === 'shop') {
      href = base + '/shop';
    } else if (l.target === 'about') {
      href = base + '/about';
    } else if (l.target === 'charters') {
      href = base + '/charters';
    } else if (l.target === 'how-it-works' || l.target === 'how') {
      href = base + '/how-it-works';
    } else if (l.target === 'team') {
      href = base + '/team';
    } else {
      href = base + '/home';
    }
    var linkCls = (l.target === 'book') ? ' class="tattoo-sidebar-link--book"' : '';
    var labelHtml = esc(l.label || '');
    if (isCharterTheme(tenant)) {
      var linkKey = String(l.target || ('link' + linkIndex)).replace(/[^A-Za-z0-9_-]/g, '');
      labelHtml = wcSpan(tenant, 'wc.charter.sidebar.' + linkKey, l.label || '');
    }
    return '<a href="'+esc(href)+'"'+linkCls+'>'+labelHtml+'</a>';
  }).join('');
}

function hamburgerMenuSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="16" viewBox="0 0 22 16" fill="none" aria-hidden="true">' +
    '<path d="M1 1.5h20M1 8h20M1 14.5h20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg>';
}

function barberPortfolioHomePage(tenant, services) {
  return classicHomePage(tenant, services || [], {
    defaultName: 'Barbershop',
    industryLabel: 'Barber',
    bookLabel: 'Book a cut',
    galleryPlaceholder: 'Add your best fades and lineups in the app.',
    featuredHeading: 'Fresh cuts & fades',
    featuredSub: 'Clean lineups, tapers, and beard work.',
    featuredEmpty: 'Your best cuts will appear here.',
    defaultBio: 'Modern cuts, clean fades, and consistent results. Every appointment is focused on quality.',
    aboutHeading: 'Precision cuts, <em>every time.</em>'
  });
}

function effectiveUnitPrice(prod) {
  var p = Number(prod.price) || 0;
  var s = prod.salePrice != null ? Number(prod.salePrice) : NaN;
  if (!isNaN(s) && s < p) return s;
  return p;
}

function formatMoney(n) {
  var x = Number(n);
  if (isNaN(x)) x = 0;
  return '$' + x.toFixed(2);
}

function formatReceiptCents(cents) {
  return formatMoney(Math.max(0, cents || 0) / 100);
}

function formatReceiptDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch (e) {
    return '';
  }
}

function loadServices(tid) {
  return db.collection('tenants').doc(tid).collection('services').get()
    .then(function(snap){
      var list = snap.docs.filter(function(d){ return d.data().isActive !== false; }).map(function(d){
        var x = d.data();
        var pr = x.price;
        var so = x.sortOrder;
        var priceNum = (typeof pr === 'number' && !isNaN(pr)) ? pr : null;
        if (priceNum == null && pr != null && String(pr).trim() !== '') {
          var parsed = parseFloat(String(pr));
          if (!isNaN(parsed) && parsed > 0) priceNum = parsed;
        }
        var dm = x.durationMinutes;
        var durNum = (typeof dm === 'number' && !isNaN(dm) && dm > 0) ? Math.round(dm) : null;
        if (durNum == null && dm != null && String(dm).trim() !== '') {
          var pdi = parseInt(String(dm), 10);
          if (!isNaN(pdi) && pdi > 0) durNum = pdi;
        }
        return {
          id: d.id,
          slug: x.slug,
          name: x.name,
          description: (x.description != null ? String(x.description) : '') || '',
          price: priceNum,
          durationMinutes: durNum,
          imageUrl: x.imageUrl || '',
          sortOrder: (typeof so === 'number' && !isNaN(so)) ? so : 1e9,
          itinerary: Array.isArray(x.itinerary) ? x.itinerary : [],
          boatId: String(x.boatId || '').trim(),
          boatIds: (function() {
            if (Array.isArray(x.boatIds) && x.boatIds.length) {
              return x.boatIds.map(function(id) { return String(id || '').trim(); }).filter(Boolean);
            }
            var one = String(x.boatId || '').trim();
            return one ? [one] : [];
          })()
        };
      });
      list.sort(function(a, b){
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return (a.name || '').localeCompare(b.name || '');
      });
      var seenSlug = {};
      list = list.filter(function(s) {
        var k = String(s.slug || s.name || '').toLowerCase();
        if (!k || seenSlug[k]) return false;
        seenSlug[k] = true;
        return true;
      });
      return list;
    });
}

function init() {
  var host = (location.hostname || '').toLowerCase();
  var ready = isBookkingPlatformHost(host)
    ? Promise.resolve('')
    : resolveCustomDomainSlug(host);
  ready.then(function(customSlug) {
  var p = parsePath(customSlug);
  var bookRedirect = memberBookPathRedirectTarget(p);
  if (bookRedirect) {
    location.replace(bookRedirect + location.hash);
    return;
  }
  var legacyTarget = legacyMemberPathRedirectTarget(p);
  if (legacyTarget && location.pathname !== legacyTarget) {
    location.replace(legacyTarget + location.search + location.hash);
    return;
  }
  if (!p.tenantSlug) {
    document.getElementById('root').innerHTML = '<div class="container"><div class="card"><h1>Get Bookking</h1><p>Enter your booking link to get started.</p></div></div>';
    return;
  }
  loadTenant(p.tenantSlug).then(function(tenant){
    if (!tenant) {
      document.getElementById('root').innerHTML = '<div class="container">'+err('Business not found')+'</div>';
      return;
    }
    if (tenant.isActive === false) {
      document.getElementById('root').innerHTML = '<div class="container">'+err('This business is not accepting bookings right now.')+'</div>';
      return;
    }
    applyPreviewThemeOverride(tenant);
    applyBranding(tenant);
    if (p.isPayPath) {
      document.getElementById('root').innerHTML = depositPayPageHtml(tenant);
      bindDepositPayPage(tenant);
      return;
    }
    return Promise.all([
      loadServices(tenant.id),
      loadProducts(tenant.id),
      themeAssetsReady(tenant),
    ]).then(function(results){
      var services = results[0];
      tenant._products = results[1];

      function renderTenantSite() {
      if (p.memberSlug && !isTeamPlan(tenant)) {
        p.memberSlug = '';
        p.page = 'home';
        p.isBookPath = false;
        p.isGalleryPath = false;
        p.isShopPath = false;
        p.isAboutPath = false;
        p.isTeamPath = false;
      }
      var isShop = p.isShopPath;
      if (p.isShopCheckoutPath) {
        if (!tenant.shopEnabled) {
          var shopBaseCheckout = tenantBaseUrl(tenant);
          document.getElementById('root').innerHTML = '<div class="container"><div class="card"><p>Shop is not enabled.</p><p><a href="' + esc(shopBaseCheckout + '/home') + '">Back to home</a></p></div></div>';
          applyBranding(tenant);
          return;
        }
        if (isCharterTheme(tenant)) {
          document.getElementById('root').innerHTML = charterShopCheckoutPage(tenant);
          bindTattooSidebar();
        } else if (isBladeTheme(tenant)) {
          document.getElementById('root').innerHTML = bladeShopCheckoutPage(tenant);
          bindTattooSidebar();
          bindBladeChrome();
        } else if (isLuxeTheme(tenant)) {
          document.getElementById('root').innerHTML = luxeShopCheckoutPage(tenant);
          bindTattooSidebar();
        } else if (isStudio12Theme(tenant)) {
          document.getElementById('root').innerHTML = studio12ShopCheckoutPage(tenant);
          bindStudio12Page();
          bindTattooSidebar();
        } else if (isStonecutTheme(tenant)) {
          document.getElementById('root').innerHTML = stonecutShopCheckoutPage(tenant);
          bindTattooSidebar();
          bindStonecutNavChrome();
        } else {
          document.getElementById('root').innerHTML = classicShopCheckoutPage(tenant);
          bindTattooSidebar();
        }
        bindShopCheckoutPage(tenant);
        applyBranding(tenant);
        if (isStudio12Theme(tenant)) applySidebarIconColor(tenant, false, false);
        else applySidebarIconColor(tenant, false, true);
        return;
      }
      if (isShop) {
        if (!tenant.shopEnabled) {
          var shopBase = tenantBaseUrl(tenant);
          document.getElementById('root').innerHTML = '<div class="container"><div class="card"><p>Shop is not enabled.</p><p><a href="' + esc(shopBase + '/home') + '">Back to home</a></p></div></div>';
          applyBranding(tenant);
          return;
        }
        if (isCharterTheme(tenant)) {
          document.getElementById('root').innerHTML = charterShopPage(tenant);
          bindCharterShop(tenant);
          bindTattooSidebar();
          bindShopPage(tenant);
          applyBranding(tenant);
          return;
        }
        if (isBladeTheme(tenant)) {
          document.getElementById('root').innerHTML = bladeShopPage(tenant);
          bindTattooSidebar();
          bindBladeChrome();
          bindShopPage(tenant);
        } else if (isLuxeTheme(tenant)) {
          document.getElementById('root').innerHTML = luxeShopPage(tenant);
          bindTattooSidebar();
          bindShopPage(tenant);
        } else if (isStudio12Theme(tenant)) {
          document.getElementById('root').innerHTML = studio12ShopPage(tenant);
          bindStudio12Page();
          bindTattooSidebar();
          bindShopPage(tenant);
        } else if (isStonecutTheme(tenant)) {
          document.getElementById('root').innerHTML = stonecutShopPage(tenant);
          bindTattooSidebar();
          bindShopPage(tenant);
          bindStonecutNavChrome();
        } else {
          document.getElementById('root').innerHTML = classicShopPage(tenant);
          bindTattooSidebar();
          bindShopPage(tenant);
        }
        applyBranding(tenant);
        if (isStudio12Theme(tenant)) applySidebarIconColor(tenant, false, false);
        else applySidebarIconColor(tenant, false, true);
        return;
      }
      if (p.isGalleryPath && !tenantShowGalleryPage(tenant)) {
        document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
        applyBranding(tenant);
        return;
      }
      if (p.isAboutPath && !tenantShowAboutPage(tenant)) {
        document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
        applyBranding(tenant);
        return;
      }
      if (p.isTeamPath && !tenantShowTeamPage(tenant)) {
        document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
        applyBranding(tenant);
        return;
      }
      if (p.isBookPath &&
          (!tenantShowBookPage(tenant) ||
           (isCharterTheme(tenant) && !tenantShowChartersPage(tenant)))) {
        document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
        applyBranding(tenant);
        return;
      }
      if (isCharterTheme(tenant) &&
          (p.isChartersPath || p.isCharterDetailPath) &&
          !tenantShowChartersPage(tenant)) {
        document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
        applyBranding(tenant);
        return;
      }
      if (isCharterTheme(tenant) &&
          p.isHowItWorksPath &&
          !tenantShowHowItWorksPage(tenant)) {
        document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
        applyBranding(tenant);
        return;
      }
      if (services.length === 0) {
        document.getElementById('root').innerHTML = '<div class="container"><div class="card"><h1>' + siteNameSpan(tenant, 'Book') + '</h1><p>No services available yet.</p></div></div>';
        applyBranding(tenant);
        return;
      }
      var presel = p.serviceSlug ? services.filter(function(s){ return s.slug === p.serviceSlug; })[0] : null;
      var showForm = p.isBookPath && services.length > 0;
      var runBookFormBind = false;
      var isGallery = p.isGalleryPath;
      var isTeam = p.isTeamPath;
      var isChartersBrowse = p.isChartersPath;
      var isHowItWorks = p.isHowItWorksPath;
      var isLuxeHome = (isLuxeTheme(tenant) && !p.isBookPath && !isGallery && !p.isShopPath && !isTeam);
      var isBladeHome = (isBladeTheme(tenant) && !p.isBookPath && !isGallery && !p.isShopPath && !isTeam);
      var isStonecutHome = (isStonecutTheme(tenant) && !p.isBookPath && !isGallery && !p.isShopPath && !isTeam);
      var isStudio12Home = (isStudio12Theme(tenant) && !p.isBookPath && !isGallery && !p.isShopPath && !isTeam);
      var isCharterSite = isCharterTheme(tenant);
      var isHairHome = (!isLuxeHome && !isBladeHome && !isStonecutHome && !isCharterSite && tenant.industry === 'hair' && !isStudio12Theme(tenant) && !p.isBookPath && !isGallery && !isTeam);
      var isBarberHome = (!isLuxeHome && !isBladeHome && !isStonecutHome && !isCharterSite && tenant.industry === 'barber' && !p.isBookPath && !isGallery && !isTeam);
      var isTattooHome = (!isLuxeHome && !isBladeHome && !isStonecutHome && !isCharterSite && tenant.industry === 'tattoos' && !p.isBookPath && !isGallery && !isTeam);
      var isNailsHome = (!isLuxeHome && !isBladeHome && !isStonecutHome && !isCharterSite && tenant.industry === 'nails' && !p.isBookPath && !isGallery && !isTeam);
      var isChartersHome = (isCharterSite && !p.isBookPath && !isGallery && !isTeam && !p.isShopPath && !isChartersBrowse && !p.isCharterDetailPath && !isHowItWorks && !p.isAboutPath);
      var isCustomHome = (!isLuxeHome && !isBladeHome && !isStonecutHome && !isCharterSite && tenant.industry === 'custom' && !p.isBookPath && !isGallery && !isTeam);
      var isThemedHome = isStudio12Home || isTattooHome || isHairHome || isBarberHome || isNailsHome || isChartersHome || isCustomHome || isLuxeHome || isBladeHome || isStonecutHome;
      function bindTeamPageChrome(tenant) {
        bindTeamSubpageChrome(tenant);
      }
      function buildThemedHomeContent() {
        return isBladeHome
          ? bladeHomePage(tenant, services)
          : isStonecutHome
            ? stonecutHomePage(tenant, services)
          : isLuxeHome
            ? luxeHomePage(tenant, services)
            : isStudio12Home
              ? studio12HomePage(tenant, services)
            : isChartersHome
              ? charterHomePage(tenant, services)
            : isTattooHome
              ? tattooHeroPage(tenant, services)
              : isHairHome
                ? hairTattooStyleHomePage(tenant, services)
                : isBarberHome
                  ? barberPortfolioHomePage(tenant, services)
                  : (isNailsHome || isCustomHome)
                    ? classicPortfolioHomePage(tenant, services)
                    : classicPortfolioHomePage(tenant, services);
      }
      if (isCharterSite && isChartersBrowse) {
        document.getElementById('root').innerHTML = charterBrowsePage(tenant, services);
        bindCharterBrowse(tenant, services);
        bindCharterScrollReveal(document.getElementById('root'));
        bindTattooSidebar();
        applyBranding(tenant);
        return;
      }
      if (isCharterSite && p.isCharterDetailPath) {
        var detailSvc = null;
        var want = String(p.charterTripSlug || p.serviceSlug || '').toLowerCase();
        for (var di = 0; di < services.length; di++) {
          if (String(services[di].slug || '').toLowerCase() === want) { detailSvc = services[di]; break; }
        }
        document.getElementById('root').innerHTML = charterDetailPage(tenant, detailSvc, services);
        bindCharterDetail(tenant, detailSvc);
        bindCharterScrollReveal(document.getElementById('root'));
        bindTattooSidebar();
        applyBranding(tenant);
        return;
      }
      if (isCharterSite && isHowItWorks) {
        document.getElementById('root').innerHTML = charterHowItWorksPage(tenant);
        bindCharterScrollReveal(document.getElementById('root'));
        bindTattooSidebar();
        applyBranding(tenant);
        return;
      }
      if (isCharterSite && p.isAboutPath) {
        document.getElementById('root').innerHTML = charterAboutPage(tenant);
        bindCharterScrollReveal(document.getElementById('root'));
        bindTattooSidebar();
        applyBranding(tenant);
        return;
      }
      if (isCharterSite && p.isBookPath) {
        var bookSlug = String(p.serviceSlug || '').toLowerCase();
        var isCharterConfirmed = bookSlug === 'confirmed';
        var charterBookSvc = null;
        var tripQ = '';
        try {
          tripQ = String((new URLSearchParams(location.search || '')).get('trip') || '').toLowerCase();
        } catch (eTrip) { tripQ = ''; }
        var wantTrip = tripQ || (isCharterConfirmed ? '' : bookSlug);
        if (wantTrip && wantTrip !== 'confirmed') {
          for (var bi = 0; bi < services.length; bi++) {
            if (String(services[bi].slug || '').toLowerCase() === wantTrip) {
              charterBookSvc = services[bi];
              break;
            }
          }
        }
        if (isCharterConfirmed) {
          if (!charterBookSvc && services.length) charterBookSvc = services[0];
          document.getElementById('root').innerHTML = charterConfirmationPage(tenant, charterBookSvc);
          bindTattooSidebar();
          applyBranding(tenant);
          return;
        }

        var checkoutSearch = charterSearchQuery();
        var checkoutTime = charterParseTimeToMin(checkoutSearch.time);
        var backToAvailability = charterSearchHref(tenant, {
          slug: charterBookSvc ? charterBookSvc.slug : '',
          date: checkoutSearch.date || '',
          people: checkoutSearch.people || 0,
          duration: checkoutSearch.duration || 0,
          boat: checkoutSearch.boat || ''
        });
        if (!charterBookSvc || !checkoutSearch.date || checkoutTime == null) {
          window.location.replace(backToAvailability);
          return;
        }

        charterBindOccupancyLifecycle(tenant);
        charterLoadOccupancy(tenant, { force: true }).then(function() {
          var checkoutDate = charterDateFromIso(checkoutSearch.date);
          var checkoutDur = Number(charterBookSvc.durationMinutes) || 240;
          var slotIsOpen = charterTripFitsDate(tenant, checkoutDate, checkoutDur, {
            occupancy: tenant._charterOccupancy || [],
            people: checkoutSearch.people || 0,
            startMin: checkoutTime,
            maxPeople: charterMaxPeopleForTrip(tenant, charterBookSvc),
            service: charterBookSvc,
            boatFilterId: checkoutSearch.boat || ''
          });
          if (!slotIsOpen) {
            window.location.replace(backToAvailability);
            return;
          }
          document.getElementById('root').innerHTML = charterCheckoutPage(tenant, charterBookSvc, services);
          bindCharterCheckout(tenant, charterBookSvc);
          bindTattooSidebar();
          applyBranding(tenant);
        }).catch(function() {
          window.location.replace(backToAvailability);
        });
        return;
      }
      if (isTeam) {
        ensureTeamProvidersLoaded(tenant, function() {
          document.getElementById('root').innerHTML = teamPage(tenant, tenant._teamProviders);
          bindTeamPageChrome(tenant);
          applyBranding(tenant);
        });
        return;
      }
      if (isGallery) {
        ensureTeamProvidersLoaded(tenant, function() {
          document.getElementById('root').innerHTML = galleryPage(tenant);
          var galleryRoot = document.getElementById('root');
          bindGalleryLightbox(galleryRoot);
          bindGalleryTeamFilter(galleryRoot);
          if (isStudio12Theme(tenant)) {
            bindStudio12Page();
            bindTattooSidebar();
          } else {
            bindTattooSidebar();
          }
          if (isBladeTheme(tenant)) bindBladeChrome();
          applyBranding(tenant);
          applySidebarIconColor(tenant, false, true);
          if (tenantShouldBindShopCart(tenant)) bindShopPage(tenant);
        });
        return;
      }
      var homeContent = buildThemedHomeContent();
      if (showForm) {
        var needsTeamBookProviders = p.isBookPath && isTeamPlan(tenant) && !tenant._memberPickerResolved;
        runBookFormBind = !needsTeamBookProviders;
        if (needsTeamBookProviders) {
          resolveTeamBookProviders(tenant, renderTenantSite);
        } else {
          document.getElementById('root').innerHTML = form(tenant, services, presel, tenant._activeProvider || null);
          if (isCharterTheme(tenant)) {
            bindTattooSidebar();
          } else if (usesThemedChrome(tenant) || isStudio12Theme(tenant)) bindTattooSidebar();
          if (isStudio12Theme(tenant)) bindStudio12Page();
          if (isBladeTheme(tenant)) bindBladeChrome();
          if (isStonecutTheme(tenant)) {
            bindStonecutNavChrome();
          }
          if (tenantShouldBindShopCart(tenant)) bindShopPage(tenant);
        }
      } else if (isThemedHome) {
        ensureTeamProvidersLoaded(tenant, function() {
          document.getElementById('root').innerHTML = buildThemedHomeContent();
          bindGalleryLightbox(document.getElementById('root'));
          if (isStudio12Home) {
            bindStudio12Page();
            bindTattooSidebar();
          } else {
            bindTattooSidebar();
          }
          if (isBladeHome) bindBladeChrome();
          if (isStonecutHome) {
            bindStonecutNavChrome();
          }
          if (tenantShouldBindShopCart(tenant)) {
            bindShopPage(tenant);
          }
          if (isChartersHome) {
            bindCharterHomeSearch(tenant, services);
            bindCharterScrollReveal(document.getElementById('root'));
          }
          applyBranding(tenant);
          applySidebarIconColor(tenant, p.isBookPath, false);
          if (p.sectionTarget) {
            setTimeout(function() {
              var target = document.getElementById(p.sectionTarget);
              if (target && target.scrollIntoView) {
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }, 0);
          }
          if (isBladeHome && (location.hash || '').toLowerCase() === '#services') {
            setTimeout(function() {
              var sec = document.getElementById('services');
              if (sec && sec.scrollIntoView) {
                sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }, 0);
          }
          if (isStudio12Home && studio12HashTargetsServices()) {
            setTimeout(studio12ScrollToServices, 80);
          }
        });
        return;
      } else {
        document.getElementById('root').innerHTML = '<div class="container">' + homeContent + '</div>';
      }
      applyBranding(tenant);
      applySidebarIconColor(tenant, p.isBookPath, false);
      if (!showForm && p.sectionTarget) {
        setTimeout(function() {
          var target = document.getElementById(p.sectionTarget);
          if (target && target.scrollIntoView) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 0);
      }
      if (!showForm && isBladeHome && (location.hash || '').toLowerCase() === '#services') {
        setTimeout(function() {
          var sec = document.getElementById('services');
          if (sec && sec.scrollIntoView) {
            sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }, 0);
      }
      if (!showForm && isStudio12Home && studio12HashTargetsServices()) {
        setTimeout(studio12ScrollToServices, 80);
      }
      if (showForm && runBookFormBind) {
        if (tenant._bookProviders && tenant._bookProviders.length) {
          bindBookingArtistSelect(tenant, tenant._bookProviders);
        }
        function uploadId() {
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
            return v.toString(16);
          });
        }
        function uploadFileFields(fm, tenantId, formResponses) {
          function runUploads(storage) {
            var authUid = firebase.auth().currentUser && firebase.auth().currentUser.uid;
            if (!authUid) {
              return Promise.reject(new Error('Sign in required for file uploads.'));
            }
            var fileInputs = fm.querySelectorAll('input[data-type="file"]');
            var fieldPromises = [];
            for (var fi = 0; fi < fileInputs.length; fi++) {
              var inp = fileInputs[fi];
              var key = inp.getAttribute('data-key');
              if (!key || !inp.files || inp.files.length === 0) continue;
              // Storage rules require folder == auth uid (anonymous session).
              var pathBase = 'tenantRefImages/' + tenantId + '/' + authUid + '/';
              var uploads = [];
              for (var j = 0; j < inp.files.length; j++) {
                var file = inp.files[j];
                var safeName = (uploadId() + '_' + (file.name || 'image')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
                var ref = storage.ref(pathBase + safeName);
                uploads.push(ref.put(file).then(function(snapshot) { return snapshot.ref.getDownloadURL(); }));
              }
              fieldPromises.push(Promise.all(uploads).then(function(urls) {
                formResponses[key] = urls;
                return urls;
              }));
            }
            if (fieldPromises.length === 0) return Promise.resolve(formResponses);
            return Promise.all(fieldPromises).then(function() { return formResponses; });
          }
          return ensureAnonymousAuth().then(function() {
            if (!window.BKSitePerf || typeof window.BKSitePerf.ensureFirebaseStorage !== 'function') {
              return Promise.reject(new Error('File uploads are unavailable.'));
            }
            return window.BKSitePerf.ensureFirebaseStorage();
          }).then(runUploads);
        }
        function setupDropzones(root) {
          if (!root) return;
          function isAllowedFile(file) {
            var t = (file && file.type) || '';
            if (t.indexOf('image/') === 0) return true;
            if (t === 'application/pdf') return true;
            var n = (file && file.name) || '';
            return /\.pdf$/i.test(n);
          }
          function isImageFile(file) {
            var t = (file && file.type) || '';
            if (t.indexOf('image/') === 0) return true;
            var n = (file && file.name) || '';
            return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(n);
          }
          function fileFingerprint(file) {
            return (file.name || '') + '|' + (file.size || 0) + '|' + (file.lastModified || 0);
          }
          function syncInputFiles(input, files) {
            var dt = new DataTransfer();
            for (var si = 0; si < files.length; si++) dt.items.add(files[si]);
            input.files = dt.files;
          }
          var dropzones = root.querySelectorAll('.upload-drop[data-reference-images-drop]');
          for (var i = 0; i < dropzones.length; i++) {
            (function(dz){
              if (dz.getAttribute('data-dropzone-bound') === '1') return;
              var input = dz.querySelector('input[type="file"]');
              var listEl = dz.querySelector('[data-upload-filelist]');
              if (!input) return;
              dz.setAttribute('data-dropzone-bound', '1');
              var selectedFiles = [];
              var previewUrls = {};

              function revokePreviewUrl(fp) {
                if (previewUrls[fp]) {
                  URL.revokeObjectURL(previewUrls[fp]);
                  delete previewUrls[fp];
                }
              }

              function addFiles(fileList) {
                if (!fileList || !fileList.length) return;
                var seen = {};
                for (var si = 0; si < selectedFiles.length; si++) seen[fileFingerprint(selectedFiles[si])] = true;
                for (var j = 0; j < fileList.length; j++) {
                  var file = fileList[j];
                  if (!isAllowedFile(file)) continue;
                  var fp = fileFingerprint(file);
                  if (seen[fp]) continue;
                  seen[fp] = true;
                  selectedFiles.push(file);
                  if (isImageFile(file)) previewUrls[fp] = URL.createObjectURL(file);
                }
                refreshList();
              }

              function removeFile(index) {
                var file = selectedFiles[index];
                if (!file) return;
                revokePreviewUrl(fileFingerprint(file));
                selectedFiles.splice(index, 1);
                refreshList();
              }

              function refreshList() {
                syncInputFiles(input, selectedFiles);
                if (!listEl) return;
                if (!selectedFiles.length) {
                  listEl.innerHTML = '';
                  return;
                }
                var html = '<div class="upload-preview-grid" role="list">';
                for (var k = 0; k < selectedFiles.length; k++) {
                  var f = selectedFiles[k];
                  var fp = fileFingerprint(f);
                  var name = f.name || ('file ' + (k + 1));
                  html += '<div class="upload-preview-item" role="listitem">';
                  if (isImageFile(f) && previewUrls[fp]) {
                    html += '<img class="upload-preview-thumb" src="' + previewUrls[fp] + '" alt="' + esc(name) + '">';
                  } else {
                    html += '<div class="upload-preview-pdf" aria-hidden="true">PDF</div>';
                  }
                  html += '<span class="upload-preview-name" title="' + esc(name) + '">' + esc(name) + '</span>';
                  html += '<button type="button" class="upload-preview-remove" data-remove-index="' + k + '" aria-label="Remove ' + esc(name) + '">&times;</button>';
                  html += '</div>';
                }
                html += '</div>';
                listEl.innerHTML = html;
                var removeBtns = listEl.querySelectorAll('[data-remove-index]');
                for (var r = 0; r < removeBtns.length; r++) {
                  (function(btn){
                    btn.addEventListener('click', function(e) {
                      e.preventDefault();
                      e.stopPropagation();
                      removeFile(parseInt(btn.getAttribute('data-remove-index'), 10));
                    });
                  })(removeBtns[r]);
                }
              }

              input.addEventListener('change', function() {
                addFiles(input.files);
              });
              dz.addEventListener('click', function(e){
                if (e.target === input) return;
                if (e.target.closest && (e.target.closest('.upload-preview-remove') || e.target.closest('.upload-preview-item'))) return;
                input.click();
              });
              dz.addEventListener('keydown', function(e){
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
              });
              ['dragenter','dragover'].forEach(function(ev){
                dz.addEventListener(ev, function(e){
                  e.preventDefault();
                  e.stopPropagation();
                  dz.classList.add('dragover');
                });
              });
              ['dragleave','drop'].forEach(function(ev){
                dz.addEventListener(ev, function(e){
                  e.preventDefault();
                  e.stopPropagation();
                  dz.classList.remove('dragover');
                });
              });
              dz.addEventListener('drop', function(e){
                var files = e.dataTransfer && e.dataTransfer.files;
                if (!files || !files.length) return;
                addFiles(files);
              });
            })(dropzones[i]);
          }
        }
        function setupPreferredDaysDropdown(fm) {
          var groups = fm.querySelectorAll('[data-pref-days-dropdown]');
          for (var gi = 0; gi < groups.length; gi++) {
            (function(group){
              var button = group.querySelector('[data-pref-days-button]');
              var menu = group.querySelector('[data-pref-days-menu]');
              var summary = group.querySelector('[data-pref-days-summary]');
              var hidden = group.querySelector('[data-preferred-days-hidden]');
              var options = group.querySelectorAll('[data-pref-day]');

              if (!button || !menu || !summary || !hidden || !options || !options.length) return;

              function selectedFromHidden() {
                var val = hidden.value || '';
                return val ? val.split(',').map(function(x){ return x.trim(); }).filter(Boolean) : [];
              }

              function updateUI(selected) {
                for (var oi = 0; oi < options.length; oi++) {
                  var opt = options[oi];
                  var day = opt.getAttribute('data-pref-day');
                  var isActive = selected.indexOf(day) >= 0;
                  opt.classList.toggle('active', isActive);
                  opt.setAttribute('aria-selected', isActive ? 'true' : 'false');
                }

                if (!selected.length) {
                  summary.textContent = 'Preferred days';
                } else {
                  // Always show the chosen days (even for 3+ selections).
                  summary.textContent = selected.join(', ');
                }
              }

              function toggleMenu(open) {
                var shouldOpen = (typeof open === 'boolean') ? open : !menu.classList.contains('open');
                if (shouldOpen) menu.classList.add('open');
                else menu.classList.remove('open');
                button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
              }

              function toggleDay(day) {
                var selected = selectedFromHidden();
                var idx = selected.indexOf(day);
                if (idx >= 0) selected.splice(idx, 1);
                else selected.push(day);
                hidden.value = selected.join(',');
                updateUI(selected);
              }

              // Initialize UI from current hidden value
              updateUI(selectedFromHidden());

              button.addEventListener('click', function(e){
                e.preventDefault();
                e.stopPropagation();
                toggleMenu();
              });

              for (var oi = 0; oi < options.length; oi++) {
                (function(opt){
                  var day = opt.getAttribute('data-pref-day');
                  opt.addEventListener('click', function(e){
                    e.preventDefault();
                    e.stopPropagation();
                    toggleDay(day);
                  });
                })(options[oi]);
              }

              document.addEventListener('click', function(ev){
                if (!group.contains(ev.target)) {
                  menu.classList.remove('open');
                  button.setAttribute('aria-expanded', 'false');
                }
              });
            })(groups[gi]);
          }
        }
        var fm = document.getElementById('book-form');
        if (fm) {
        setupDropzones(fm);
        setupPreferredDaysDropdown(fm);
        setupGuidedBookingForm(fm, setupDropzones);
        setupCalendarBookingForm(fm, tenant, services);
        injectBookingSmsConsent(fm, tenant);
        attachTitleCaseNameInputs(fm);
        fm.addEventListener('submit', function(ev){
          ev.preventDefault();
          if (fm.dataset.guidedStep) {
            var confirmAt = fm.getAttribute('data-guided-confirm-step') || '3';
            if (fm.dataset.guidedStep !== confirmAt) return;
          }
          if (fm.dataset.calStep != null && fm.hasAttribute('data-cal-wizard-form')) {
            var calConfirm = fm.getAttribute('data-cal-confirm-step') || '0';
            if (String(fm.dataset.calStep) !== String(calConfirm)) return;
          }
          var errEl = document.getElementById('form-error');
          errEl.style.display = 'none';
          var btn = fm.querySelector('button[type="submit"]');
          btn.disabled = true;
          var origText = btn.textContent;
          btn.textContent = 'Uploading…';
          var formResponses = {};
          [].forEach.call(fm.querySelectorAll('[data-key]'), function(el){
            if (el.getAttribute('data-type') === 'file') return;
            var k = el.getAttribute('data-key');
            var v = (el.value||'').trim();
            if (k) formResponses[k] = v || null;
          });
          if (formResponses.name) {
            formResponses.name = titleCaseWords(formResponses.name);
            var nameInput = fm.querySelector('input[data-key="name"]');
            if (nameInput) nameInput.value = formResponses.name;
          }
          uploadFileFields(fm, tenant.id, formResponses).then(function() {
            btn.textContent = 'Submitting…';
            var customerName = formResponses.name || '';
            function normalizeEmail(v) {
              return (v || '').toString().trim().toLowerCase().replace(/\s+/g, '');
            }
            function normalizePhone(raw) {
              var s = (raw || '').toString().trim();
              if (!s) return null;

              var hasPlus = s.charAt(0) === '+';
              var digits = s.replace(/\D/g, '');
              if (!digits) return null;

              function formatUS10(d10) {
                return '(' + d10.slice(0,3) + ') ' + d10.slice(3,6) + '-' + d10.slice(6,10);
              }

              // US +1 or 10-digit formats
              if (digits.length === 10) return formatUS10(digits);
              if (digits.length === 11 && digits.charAt(0) === '1') return formatUS10(digits.slice(1));

              // If user entered +<country>, preserve best-effort with +
              if (hasPlus) return '+' + digits;

              // Best-effort for all other countries: prefix + for anything >= 7 digits
              if (digits.length >= 7) return '+' + digits;

              // Too short: keep raw digits
              return digits;
            }
            var customerEmail = normalizeEmail(formResponses.email);
            var customerPhone = normalizePhone(formResponses.phone);
            var preferredDays = null;
            if (formResponses.preferredDays) {
              preferredDays = (formResponses.preferredDays || '')
                .toString()
                .split(',')
                .map(function(x){ return (x||'').trim(); })
                .filter(Boolean);
              if (!preferredDays.length) preferredDays = null;
            }
            var preferredTime =
              (formResponses.preferredTime || formResponses.preferredTimeOfDay || '').toString().trim();
            if (!preferredTime) preferredTime = null;
            var serviceId = null, serviceSlugVal = null, serviceName = null;
            var sel = fm.querySelector('[data-key="service"]');
            if (sel && sel.tagName === 'SELECT' && sel.options && sel.options[sel.selectedIndex]) {
              var opt = sel.options[sel.selectedIndex];
              serviceId = opt.value;
              serviceSlugVal = opt.dataset.slug || null;
              serviceName = opt.dataset.name || null;
            } else if (sel && sel.value) {
              serviceId = sel.value;
              serviceSlugVal = sel.getAttribute('data-slug') || sel.dataset.slug || null;
              serviceName = sel.getAttribute('data-name') || sel.dataset.name || null;
            }
            if (!serviceId) {
              errEl.textContent = 'Please select a service.';
              errEl.style.display = 'block';
              btn.disabled = false;
              btn.textContent = origText;
              return;
            }
            var calMemberEl = fm.querySelector('[data-cal-member-slug]');
            if (calMemberEl && calMemberEl.value) {
              tenant._activeProvider = tenant._activeProvider || {};
              tenant._activeProvider.memberSlug = calMemberEl.value;
              var calNameEl = fm.querySelector('[data-cal-member-name]');
              if (calNameEl && calNameEl.value) tenant._activeProvider.displayName = calNameEl.value;
            }
            var smsConsentAccepted = false;
            var smsConsentEl = fm.querySelector('[data-sms-consent-checkbox]');
            if (smsConsentEl) smsConsentAccepted = smsConsentEl.checked === true;
            if (customerPhone && smsConsentEl && !smsConsentAccepted) {
              errEl.textContent = 'Please agree to receive appointment-related text messages to continue.';
              errEl.style.display = 'block';
              btn.disabled = false;
              btn.textContent = origText;
              return;
            }
            if (smsConsentAccepted && !customerPhone) {
              errEl.textContent = 'Please enter your mobile number to receive text messages.';
              errEl.style.display = 'block';
              btn.disabled = false;
              btn.textContent = origText;
              return;
            }
            return functions.httpsCallable('createBookingRequestFromWeb')({
              tenantSlug: tenant.slug,
              memberSlug: (tenant._activeProvider && tenant._activeProvider.memberSlug) || null,
              assignmentPreference: tenant._assignmentPreference || null,
              customerName: customerName,
              customerEmail: customerEmail,
              customerPhone: customerPhone,
              smsConsentAccepted: smsConsentAccepted,
              serviceId: serviceId,
              serviceSlug: serviceSlugVal,
              serviceName: serviceName,
              preferredTime: preferredTime,
              preferredDays: preferredDays,
              notes: formResponses.notes || null,
              formResponses: formResponses
            });
          }).then(function(){
            var doneHtml = bookingSuccessHtml(tenant);
            document.getElementById('root').innerHTML = (usesThemedChrome(tenant) || isStudio12Theme(tenant)) ? doneHtml : '<div class="container">' + doneHtml + '</div>';
            applyBranding(tenant);
            if (usesThemedChrome(tenant) || isStudio12Theme(tenant)) bindTattooSidebar();
            if (isStudio12Theme(tenant)) bindStudio12Page();
            if (isBladeTheme(tenant)) bindBladeChrome();
            if (isStonecutTheme(tenant)) {
              bindStonecutNavChrome();
            }
            applySidebarIconColor(tenant, true, false);
          }).catch(function(e){
            errEl.textContent = (e && e.message) ? e.message : 'Something went wrong. Please try again.';
            errEl.style.display = 'block';
            btn.disabled = false;
            btn.textContent = origText;
          });
        });
        }
      }
      }

      if (p.memberSlug && isTeamPlan(tenant)) {
        if (!tenantShowTeamPage(tenant)) {
          document.getElementById('root').innerHTML = publicSitePageUnavailableHtml(tenant);
          applyBranding(tenant);
          return;
        }
        return loadPublicProvider(tenant.slug, p.memberSlug).then(function(provider) {
          if (!provider) {
            document.getElementById('root').innerHTML = '<div class="container">' + err('Team member not found') + '</div>';
            applyBranding(tenant);
            return;
          }
          if (p.isGalleryPath) {
            document.getElementById('root').innerHTML = providerGalleryPageHtml(tenant, provider);
            bindGalleryLightbox(document.getElementById('root'));
            applyBranding(tenant);
            return;
          }
          if (!p.isBookPath) {
            document.getElementById('root').innerHTML = teamMemberProfilePageHtml(tenant, provider);
            bindTeamSubpageChrome(tenant);
            applyBranding(tenant);
            return;
          }
        });
      }
      renderTenantSite();
    });
  }).catch(function(e){
    console.error(e);
    document.getElementById('root').innerHTML = '<div class="container">'+err(e && e.message ? e.message : 'Failed to load.')+'</div>';
  });
  }).catch(function(e){
    console.error(e);
    document.getElementById('root').innerHTML = '<div class="container">'+err(e && e.message ? e.message : 'Failed to load.')+'</div>';
  });
}
