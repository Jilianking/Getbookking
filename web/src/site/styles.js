/* Applying colors, fonts, text styles, and section layouts. */

function fontStackForDisplayKey(key) {
  var k = (key || 'kanit').toLowerCase();
  if (k === 'oswald') {
    return "'Oswald', system-ui, sans-serif";
  }
  if (k === 'playfair') {
    return "'Playfair Display', Georgia, serif";
  }
  if (k === 'plus-jakarta-sans') {
    return "'Plus Jakarta Sans', system-ui, sans-serif";
  }
  if (k === 'teko') {
    return "'Teko', system-ui, sans-serif";
  }
  if (k === 'libre-baskerville') {
    return "'Libre Baskerville', Georgia, serif";
  }
  if (k === 'cormorant-garamond') {
    return "'Cormorant Garamond', Georgia, serif";
  }
  if (k === 'poiret-one') {
    return "'Poiret One', system-ui, sans-serif";
  }
  if (k === 'foglihten-no06') {
    return "'Foglihten No06', Georgia, serif";
  }
  if (k === 'butler') {
    return "'Butler', 'Libre Baskerville', Georgia, serif";
  }
  return "'Kanit', system-ui, sans-serif";
}

/** `--font-hero` from resolved web theme only (Classic + Luxe hero titles; Blade uses scoped CSS). Ignores stored heroFont. */
function templateHeroFontKey(tenant) {
  var id = '';
  if (tenant && tenant.resolvedWebThemeId) {
    id = String(tenant.resolvedWebThemeId);
  } else if (tenant) {
    id = resolvedWebThemeId(tenant);
  }
  if (id === 'luxe-v1') return 'cormorant-garamond';
  if (id === 'blade-v1') return 'kanit';
  if (id === 'stonecut-v1') return 'kanit';
  return 'kanit';
}

function applyTenantTypography(t) {
  var key = templateHeroFontKey(t);
  var el = document.getElementById('adobe-fonts-typekit');
  if (el) el.remove();
  var uiStack = "'Inter', system-ui, sans-serif";
  var heroStack = fontStackForDisplayKey(key);
  document.documentElement.style.setProperty('--font-display', uiStack);
  document.documentElement.style.setProperty('--font-hero', heroStack);
  return themeAssetsReady(t);
}

function pickTenantHex(stored, fallback) {
  var s = (stored == null ? '' : String(stored)).trim();
  return s || fallback;
}

/** Default-preset colors per layout family (when Firestore field is empty). Blade → Pearl Light. */
function themeColorDefaults(tenant) {
  if (isBladeTheme(tenant)) {
    return { bg: '#ffffff', fg: '#1a1f28', card: '#eef1f4', accent: '#5a8cc0', accentHover: '#4678a8', accentFg: '#ffffff',
      featuredBg: '#f6f7f8', featuredFg: '#1a1f28', galleryBg: '#f6f7f8', galleryFg: '#1a1f28', aboutBg: '#2a3238', aboutFg: '#f6f7f8' };
  }
  if (isStonecutTheme(tenant)) {
    return { bg: '#060604', fg: '#e8e0d0', card: '#0e0d0a', accent: '#c0221a', accentHover: '#d42a20', accentFg: '#e8e0d0',
      featuredBg: '#060604', featuredFg: '#e8e0d0', galleryBg: '#060604', galleryFg: '#e8e0d0', aboutBg: '#0e0d0a', aboutFg: '#e8e0d0' };
  }
  if (isStudio12Theme(tenant)) {
    return { bg: '#faf7f2', fg: '#2a1f18', card: '#e8d5c4', accent: '#b08060', accentHover: '#8a6040', accentFg: '#faf7f2',
      featuredBg: '#faf7f2', featuredFg: '#2a1f18', galleryBg: '#faf7f2', galleryFg: '#2a1f18', aboutBg: '#2a1f18', aboutFg: '#faf7f2' };
  }
  if (isLuxeTheme(tenant)) {
    return { bg: '#FFFDF9', fg: '#1a1a1a', card: '#f5f0e8', accent: '#C9A96E', accentHover: '#8B6914', accentFg: '#ffffff',
      featuredBg: '#FFFDF9', featuredFg: '#1a1a1a', galleryBg: '#FFFDF9', galleryFg: '#1a1a1a', aboutBg: '#1a1a1a', aboutFg: '#FFFDF9' };
  }
  return { bg: '#ffffff', fg: '#1a1a1a', card: '#f5f5f5', accent: '#111111', accentHover: '#333333', accentFg: '#f7f5f0',
    featuredBg: '#ffffff', featuredFg: '#1a1a1a', galleryBg: '#ffffff', galleryFg: '#1a1a1a', aboutBg: '#1a1a1a', aboutFg: '#f7f5f0' };
}

function accentFgForHex(accentHex, fallback) {
  var rgb = hexToRgb(accentHex);
  var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.58 ? '#1a1a1a' : (fallback || '#f5f0e8');
}

function tenantColors(tenant) {
  var d = themeColorDefaults(tenant);
  var bg = pickTenantHex(tenant.backgroundColor, d.bg);
  var fg = pickTenantHex(tenant.textColor, d.fg);
  var card = pickTenantHex(tenant.cardSurfaceColor, d.card);
  var accent = pickTenantHex(tenant.primaryColor, d.accent);
  var accentHover = pickTenantHex(tenant.primaryColorHover, d.accentHover);
  var featuredBg = pickTenantHex(tenant.featuredWorkBackgroundColor, d.featuredBg);
  var featuredFg = pickTenantHex(tenant.featuredWorkTextColor, d.featuredFg);
  var galleryBg = pickTenantHex(tenant.galleryPageBackgroundColor, featuredBg);
  var galleryFg = pickTenantHex(tenant.galleryPageTextColor, featuredFg);
  var aboutBg = pickTenantHex(tenant.aboutSectionBackgroundColor, d.aboutBg);
  var aboutFg = pickTenantHex(tenant.aboutSectionTextColor, d.aboutFg);
  var accentFg = accentFgForHex(accent, d.accentFg);
  return {
    bg: bg, fg: fg, card: card, accent: accent, accentHover: accentHover, accentFg: accentFg,
    featuredBg: featuredBg, featuredFg: featuredFg, galleryBg: galleryBg, galleryFg: galleryFg,
    aboutBg: aboutBg, aboutFg: aboutFg
  };
}

function tenantSurfaceColors(tenant, surface) {
  var c = tenantColors(tenant);
  if (surface === 'gallery') return { bg: c.galleryBg, fg: c.galleryFg };
  if (surface === 'featured') return { bg: c.featuredBg, fg: c.featuredFg };
  if (surface === 'card') return { bg: c.card, fg: c.fg };
  if (surface === 'about') return { bg: c.aboutBg, fg: c.aboutFg };
  return { bg: c.bg, fg: c.fg };
}

function hexToRgb(hex) {
  var h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) {
    return { r: 42, g: 31, b: 24 };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function rgbaFromHex(hex, alpha) {
  var rgb = hexToRgb(hex);
  return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
}

function contrastingInkHex(bg) {
  var rgb = hexToRgb(bg);
  var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return lum > 0.58 ? '#111111' : '#ffffff';
}

/** Open / Close / drawer fill / link color — not header, not wordmark. */
function sidebarChromeResolved(tenant) {
  var tc = tenantColors(tenant);
  var defaultBg = tc.card;
  var defaultFg = tc.fg;
  var defaultOpen = tc.fg;
  if (isBladeTheme(tenant)) {
    defaultOpen = tc.accent;
  } else if (usesAccentSidebarDrawer(tenant)) {
    defaultBg = tc.accent;
    defaultFg = tc.accentFg;
    defaultOpen = tc.accent;
  }
  var bg = pickTenantHex(tenant.sidebarBackgroundColor, defaultBg);
  var fg = pickTenantHex(tenant.sidebarTextColor, defaultFg);
  return {
    bg: bg,
    fg: fg,
    close: pickTenantHex(tenant.sidebarCloseIconColor, contrastingInkHex(bg)),
    open: pickTenantHex(tenant.sidebarIconColorHome,
      pickTenantHex(tenant.sidebarIconColorBooking, defaultOpen))
  };
}

function applySidebarChromeColors(tenant) {
  if (!tenant) return;
  var sc = sidebarChromeResolved(tenant);
  var root = document.documentElement;
  root.style.setProperty('--bk-sidebar-accent-bg', sc.bg);
  root.style.setProperty('--bk-sidebar-accent-fg', sc.fg);
  root.style.setProperty('--bk-sidebar-accent-divider', rgbaFromHex(sc.fg, 0.28));
  root.style.setProperty('--bk-sidebar-close-icon', sc.close);
  root.style.setProperty('--bk-sidebar-open-icon', sc.open);
  [].forEach.call(document.querySelectorAll('.tattoo-sidebar-panel'), function(panel) {
    panel.style.background = sc.bg;
    panel.style.color = sc.fg;
  });
  [].forEach.call(document.querySelectorAll('.tattoo-sidebar-panel a'), function(a) {
    try { a.style.setProperty('color', sc.fg); }
    catch (e) { a.style.color = sc.fg; }
  });
  /* Drawer title uses Sidebar Text (not header name color). */
  [].forEach.call(document.querySelectorAll('.tattoo-sidebar-wordmark [data-edit-key]'), function(span) {
    var k = (span.getAttribute('data-edit-key') || '').trim();
    var override = (window.__bkCachedWebTextColors || {})[k];
    if (override && String(override).charAt(0) === '#') return;
    try { span.style.setProperty('color', sc.fg, 'important'); }
    catch (eWord) { span.style.color = sc.fg; }
  });
  [].forEach.call(document.querySelectorAll('.tattoo-sidebar-close'), function(btn) {
    try { btn.style.setProperty('color', sc.close, 'important'); }
    catch (e2) { btn.style.color = sc.close; }
  });
  [].forEach.call(document.querySelectorAll('.tattoo-nav-menu'), function(b) {
    try {
      b.style.setProperty('color', sc.open, 'important');
      if (b.classList && b.classList.contains('blade-nav-menu-btn')) {
        b.style.setProperty('-webkit-text-fill-color', sc.open, 'important');
      }
    } catch (e3) { b.style.color = sc.open; }
  });
}

function applyTenantColorVars(tenant) {
  var c = tenantColors(tenant);
  var root = document.documentElement;
  root.style.setProperty('--bk-bg', c.bg);
  root.style.setProperty('--bk-fg', c.fg);
  root.style.setProperty('--bk-card', c.card);
  root.style.setProperty('--bk-accent', c.accent);
  root.style.setProperty('--bk-accent-hover', c.accentHover);
  root.style.setProperty('--bk-accent-fg', c.accentFg);
  var sc = sidebarChromeResolved(tenant);
  root.style.setProperty('--bk-sidebar-accent-bg', sc.bg);
  root.style.setProperty('--bk-sidebar-accent-fg', sc.fg);
  root.style.setProperty('--bk-sidebar-accent-divider', rgbaFromHex(sc.fg, 0.28));
  root.style.setProperty('--bk-sidebar-close-icon', sc.close);
  root.style.setProperty('--bk-sidebar-open-icon', sc.open);
  root.style.setProperty('--bk-featured-bg', c.featuredBg);
  root.style.setProperty('--bk-featured-fg', c.featuredFg);
  root.style.setProperty('--bk-gallery-bg', c.galleryBg);
  root.style.setProperty('--bk-gallery-fg', c.galleryFg);
  root.style.setProperty('--bk-about-bg', c.aboutBg);
  root.style.setProperty('--bk-about-fg', c.aboutFg);
  root.style.setProperty('--bk-band-bg', c.card);
  root.style.setProperty('--bk-accent-10', rgbaFromHex(c.accent, 0.10));
  root.style.setProperty('--bk-accent-12', rgbaFromHex(c.accent, 0.12));
  root.style.setProperty('--bk-accent-16', rgbaFromHex(c.accent, 0.16));
  root.style.setProperty('--bk-accent-18', rgbaFromHex(c.accent, 0.18));
  root.style.setProperty('--bk-accent-22', rgbaFromHex(c.accent, 0.22));
  root.style.setProperty('--bk-accent-35', rgbaFromHex(c.accent, 0.35));
  root.style.setProperty('--bk-accent-55', rgbaFromHex(c.accent, 0.55));
  root.style.setProperty('--bk-fg-muted', rgbaFromHex(c.fg, 0.58));
  root.style.setProperty('--bk-fg-muted-light', rgbaFromHex(c.fg, 0.40));
  root.style.setProperty('--bk-fg-07', rgbaFromHex(c.fg, 0.07));
  root.style.setProperty('--bk-fg-10', rgbaFromHex(c.fg, 0.10));
  var heroSlot = tenantHeroPlaceholderSlotStyle(c);
  var slot = tenantPlaceholderSlotStyle(c, { accentMix: 32, borderAlpha: 0.55 });
  var slotLight = tenantPlaceholderSlotStyle(c, { accentMix: 22, borderAlpha: 0.35, borderWidth: '1px' });
  root.style.setProperty('--bk-hero-slot-bg', heroSlot.bg);
  root.style.setProperty('--bk-hero-slot-border', heroSlot.border);
  root.style.setProperty('--bk-slot-bg', slot.bg);
  root.style.setProperty('--bk-slot-border', slot.border);
  root.style.setProperty('--bk-slot-border-light', slotLight.border);
}

function applyBodyPageColors(tenant, surface) {
  var s = tenantSurfaceColors(tenant, surface || 'page');
  document.body.style.background = s.bg;
  document.body.style.color = s.fg;
  document.body.style.backgroundImage = '';
}

/** Fast path: CSS vars + page bg only (color wheel drag). */
function applyPreviewColorPatchFast(patch) {
  if (!patch) return;
  patch.resolvedWebThemeId = patch.resolvedWebThemeId || resolvedWebThemeId(patch);
  applyTenantColorVars(patch);
  if (patch.heroSlotBg) {
    document.documentElement.style.setProperty('--bk-hero-slot-bg', patch.heroSlotBg);
  }
  applyBodyPageColors(patch, 'page');
  applySidebarChromeColors(patch);
}

/** Paint every Quick-edit color band from palette tokens (home + /book + /gallery). */
function applyColorSurfaceBands(tenant) {
  if (!tenant) return;
  var c = tenantColors(tenant);
  [].forEach.call(document.querySelectorAll('[data-bk-color-surface]'), function(el) {
    if (el.tagName === 'NAV') return;
    // Keyed spots are owned by applyWebSurfaceColors — never stamp the shared role token.
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    if (el.parentElement && el.parentElement.closest && el.parentElement.closest('[data-bk-surface-key]')) return;
    var sid = el.getAttribute('data-bk-color-surface');
    if (!sid) return;
    var bg = null;
    var fg = null;
    if (sid === 'page') { bg = c.bg; fg = c.fg; }
    else if (sid === 'hero') {
      if (isBladeTheme(tenant) || isStonecutTheme(tenant) || isCharterTheme(tenant) || (isClassicTheme(tenant) && !isStudio12Theme(tenant))) {
        bg = c.bg; fg = c.fg;
      } else return;
    }
    else if (sid === 'card') { bg = c.card; fg = c.fg; }
    else if (sid === 'featured') { bg = c.featuredBg; fg = c.featuredFg; }
    else if (sid === 'gallery') { bg = c.galleryBg; fg = c.galleryFg; }
    else if (sid === 'about') { bg = c.aboutBg; fg = c.aboutFg; }
    else return;
    if (bg) el.style.background = bg;
    if (fg && !el.querySelector('[data-edit-key]')) el.style.color = fg;
  });
}

/** Live preview color updates from app Quick edit (tap band or chrome). */
function applyPreviewColorPatch(patch, opts) {
  if (!patch) return;
  var full = !opts || opts.full !== false;
  applyPreviewColorPatchFast(patch);
  if (!full) return;
  if (isLuxeTheme(patch)) {
    applyLuxeHomeBandColors(patch);
    applyEmptyImageSlotColors(patch);
  } else if (isBladeTheme(patch)) {
    applyBladeHomeBandColors(patch);
    applyEmptyImageSlotColors(patch);
  } else if (isStonecutTheme(patch)) {
    applyStonecutHomeBandColors(patch);
    applyEmptyImageSlotColors(patch);
  } else if (isStudio12Theme(patch)) {
    applyStudio12HomeBandColors(patch);
  } else if (isCharterTheme(patch)) {
    applyEmptyImageSlotColors(patch);
  } else if (isClassicTheme(patch) && !isStudio12Theme(patch)) {
    applyClassicHomePlaceholderColors(patch);
    applyEmptyImageSlotColors(patch);
  }
  applyColorSurfaceBands(patch);
  if (isCharterTheme(patch)) applyCharterHomeBandColors(patch);
  applyWebSurfaceColors(patch);
  applyWebButtonColors(patch);
  applyWebTextStyles(patch);
  applySidebarChromeColors(patch);
}

function roleBgForColorSurface(sid, tc) {
  if (sid === 'page' || sid === 'hero') return tc.bg;
  if (sid === 'card') return tc.card;
  if (sid === 'featured') return tc.featuredBg;
  if (sid === 'gallery') return tc.galleryBg;
  if (sid === 'about') return tc.aboutBg;
  return null;
}

function roleFgForColorSurface(sid, tc) {
  if (sid === 'page' || sid === 'hero' || sid === 'card') return tc.fg;
  if (sid === 'featured') return tc.featuredFg;
  if (sid === 'gallery') return tc.galleryFg;
  if (sid === 'about') return tc.aboutFg;
  return null;
}

/** Default palette role ink on keyed bands (no custom webSurfaceColors fill). */
function applyKeyedSurfaceRoleFallback(el, sid, bg, tc) {
  if (!el || !tc || el.tagName === 'NAV') return;
  var fg = roleFgForColorSurface(sid, tc);
  if (!fg) return;
  if (sid === 'about') {
    el.style.color = fg;
    if (bg) el.style.setProperty('--bk-about-bg', bg);
    el.style.setProperty('--bk-about-fg', fg);
  } else if (sid === 'card' || sid === 'featured' || sid === 'gallery') {
    el.style.color = fg;
  }
}

function tenantHasColorTokens(tenant) {
  if (!tenant) return false;
  return !!(tenant.backgroundColor || tenant.aboutSectionBackgroundColor ||
    tenant.cardSurfaceColor || tenant.primaryColor ||
    tenant.resolvedWebThemeId || tenant.webThemeId);
}

/**
 * Per-band fills from tenant `webSurfaceColors` (`data-bk-surface-key`).
 * Unlisted bands keep the palette role (`data-bk-color-surface`).
 */
function applyWebSurfaceColors(tenant) {
  if (!tenant) return;
  var colors;
  if (Object.prototype.hasOwnProperty.call(tenant, 'webSurfaceColors')) {
    colors = coerceStyleMap(tenant.webSurfaceColors);
    var nativeSurf = window.__bkNativeSurfaceColors;
    if (nativeSurf) {
      Object.keys(nativeSurf).forEach(function(k) {
        var v = nativeSurf[k];
        if (v && String(v).charAt(0) === '#') colors[k] = v;
      });
    }
  } else if (window.__bkNativeSurfaceColors != null) {
    colors = coerceStyleMap(window.__bkNativeSurfaceColors);
  } else {
    colors = window.__bkCachedWebSurfaceColors || {};
  }
  // Luxe: former shared `luxe.footer` → contact only (legal is `luxe.legal`).
  if ((!colors['luxe.contact'] || colors['luxe.contact'].charAt(0) !== '#') &&
      colors['luxe.footer'] && colors['luxe.footer'].charAt(0) === '#') {
    colors['luxe.contact'] = colors['luxe.footer'];
  }
  window.__bkCachedWebSurfaceColors = colors;
  var tc = tenantHasColorTokens(tenant) ? tenantColors(tenant) : null;
  [].forEach.call(document.querySelectorAll('[data-bk-surface-key]'), function(el) {
    var key = (el.getAttribute('data-bk-surface-key') || '').trim();
    if (!key) return;
    var col = colors[key];
    if (key === 'charter.hero') {
      paintCharterHeroSurface(el, tenant, col, tc);
      return;
    }
    if (key === 'luxe.hero') {
      if (col && col.charAt(0) === '#') {
        el.style.setProperty('background-color', col, 'important');
      } else {
        el.style.removeProperty('background-color');
      }
      return;
    }
    if (col && col.charAt(0) === '#') {
      try { el.style.setProperty('background', col, 'important'); }
      catch (e) { el.style.background = col; }
      applyKeyedAboutBandInk(el, key, col, tc);
      applyKeyedStonecutSvcCardInk(el, key, col);
      applyKeyedStudio12CardInk(el, key, col);
      applyKeyedCharterSurfaceInk(el, key, col);
      if (key === 'classic.hero' || key === 'blade.hero') {
        document.documentElement.style.setProperty('--bk-hero-bg', col);
      }
      if (key === 'blade.bookingPage') {
        applyBladeBookingPageRootFill(col);
      }
      if (key === 'luxe.bookingPage') {
        applyLuxeBookingPageRootFill(col);
      }
      if (key === 'stonecut.bookingPage') {
        applyStonecutBookingPageRootFill(col);
      }
      if (key === 'studio12.bookingPage') {
        applyStudio12BookingPageRootFill(col);
      }
      if (key === 'charter.bookingPage') {
        applyCharterBookingPageRootFill(col);
      }
    } else {
      var sid = el.getAttribute('data-bk-color-surface') || '';
      var fallback = tc ? roleBgForColorSurface(sid, tc) : null;
      if (!fallback) fallback = roleBgFromLiveCss(sid);
      if (el.tagName === 'NAV' || key === 'classic.footer') {
        el.style.removeProperty('background');
      } else if (fallback) {
        try { el.style.setProperty('background', fallback, 'important'); }
        catch (e2) { el.style.background = fallback; }
      } else {
        el.style.removeProperty('background');
      }
      clearKeyedAboutBandInk(el, key, tc);
      clearKeyedStonecutSvcCardInk(el, key);
      clearKeyedStudio12CardInk(el, key);
      clearKeyedCharterSurfaceInk(el, key);
      if (key === 'classic.hero' || key === 'blade.hero') {
        document.documentElement.style.removeProperty('--bk-hero-bg');
      }
      if (key === 'blade.bookingPage') {
        // Clear book-only override; root falls back to role page (does not rewrite home).
        applyBladeBookingPageRootFill(fallback || '');
      }
      if (key === 'luxe.bookingPage') {
        applyLuxeBookingPageRootFill(fallback || '');
      }
      if (key === 'stonecut.bookingPage') {
        applyStonecutBookingPageRootFill(fallback || '');
      }
      if (key === 'studio12.bookingPage') {
        applyStudio12BookingPageRootFill(fallback || '');
      }
      if (key === 'charter.bookingPage') {
        applyCharterBookingPageRootFill(fallback || '');
      }
      if (fallback) {
        applyKeyedCharterSurfaceInk(el, key, fallback);
        if (tc) applyKeyedSurfaceRoleFallback(el, sid, fallback, tc);
      } else {
        el.style.removeProperty('color');
      }
    }
  });
}

/** Per-CTA fills from tenant `webButtonColors` (`data-cta-key`). Header keys are shared across pages. */
function applyWebButtonColors(tenant) {
  if (!tenant) return;
  var colors;
  if (Object.prototype.hasOwnProperty.call(tenant, 'webButtonColors')) {
    colors = coerceStyleMap(tenant.webButtonColors);
    var nativeBtn = window.__bkNativeButtonColors;
    if (nativeBtn) {
      Object.keys(nativeBtn).forEach(function(k) {
        var v = nativeBtn[k];
        if (v && String(v).charAt(0) === '#') colors[k] = v;
      });
    }
  } else if (window.__bkNativeButtonColors != null) {
    colors = coerceStyleMap(window.__bkNativeButtonColors);
  } else {
    colors = window.__bkCachedWebButtonColors || {};
  }
  window.__bkCachedWebButtonColors = colors;
  [].forEach.call(document.querySelectorAll('[data-cta-key]'), function(el) {
    var key = (el.getAttribute('data-cta-key') || '').trim();
    if (!key) return;
    var col = colors[key];
    if (col && col.charAt(0) === '#') {
      try {
        el.style.setProperty('background', col, 'important');
        // Keep the label readable on light fills (e.g. a white button on a dark section).
        el.style.setProperty('color', hexIsLight(col) ? '#111111' : '#FFFFFF', 'important');
      }
      catch (e) { el.style.background = col; }
    } else {
      el.style.removeProperty('background');
      el.style.removeProperty('color');
    }
  });
}

function applyBranding(t) {
  if (!t) return;
  applySiteSeo(t);
  applySiteAnnouncement(t);
  applyTenantColorVars(t);
  var c = tenantColors(t);
  var bodySurface = 'page';
  if (isLuxeTheme(t) || isBladeTheme(t) || isStonecutTheme(t) || isStudio12Theme(t) ||
      isCharterTheme(t) || (isClassicTheme(t) && !isStudio12Theme(t))) {
    bodySurface = 'page';
  } else if (t.industry === 'hair' || t.industry === 'barber' || t.industry === 'nails' ||
      t.industry === 'custom' || t.industry === 'tattoos') {
    bodySurface = 'featured';
  }
  applyBodyPageColors(t, bodySurface);
  applyLuxeHomeBandColors(t);
  applyEmptyImageSlotColors(t);
  applyClassicHomePlaceholderColors(t);
  applyBladeHomeBandColors(t);
  applyStonecutHomeBandColors(t);
  applyStudio12HomeBandColors(t);
  applyColorSurfaceBands(t);
  applyCharterHomeBandColors(t);
  applyWebSurfaceColors(t);
  applyCharterHeroPhoto(t);
  [].forEach.call(document.querySelectorAll('.card'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.card;
  });
  [].forEach.call(document.querySelectorAll('button[data-accent]'), function(el) {
    if ((el.getAttribute('data-cta-key') || '').trim()) return;
    el.style.background = c.accent;
    el.style.color = c.accentFg;
  });
  applyWebButtonColors(t);
  applySectionLayouts(t);
  applyTenantTypography(t);
  applyWebTextStyles(t);
  applySidebarChromeColors(t);
}

function hexIsLight(hex) {
  var h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
  if (h.length !== 6) return false;
  var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160;
}

function applySectionLayouts(tenant) {
  // The editor reads this to know which layout the template uses when none is saved.
  if (tenant && tenant.resolvedWebThemeId) {
    document.documentElement.setAttribute('data-bk-theme', tenant.resolvedWebThemeId);
  }
  var raw = tenant && tenant.webSectionLayouts;
  var map = (raw && typeof raw === 'object') ? raw : {};
  // Local dev only: the editor's Preview button passes layouts that haven't reached publicSites.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    // Clear copies left by an old local-dev workaround so they can't override publicSites.
    try { localStorage.removeItem('bk_published_layouts:' + String((tenant && tenant.slug) || '').toLowerCase()); } catch (e) { /* storage blocked */ }
    try {
      // Keep them for the tab so clicking to other pages doesn't drop them.
      var param = new URLSearchParams(location.search).get('bk_layouts');
      if (param) sessionStorage.setItem('bk_layouts', param);
      else param = sessionStorage.getItem('bk_layouts');
      if (param) map = Object.assign({}, map, JSON.parse(param));
    } catch (e) { /* ignore bad param or blocked storage */ }
  }
  BK_LAYOUT_SLOTS.forEach(function (slot) {
    var value = map[slot] ? String(map[slot]).trim() : '';
    if (value) document.documentElement.setAttribute('data-bk-layout-' + slot, value);
    else document.documentElement.removeAttribute('data-bk-layout-' + slot);
    BK_LAYOUT_PROPS.forEach(function (prop) {
      var attr = 'data-bk-layout-' + slot + '-' + prop.toLowerCase();
      var propValue = map[slot + prop] ? String(map[slot + prop]).trim() : '';
      if (propValue) document.documentElement.setAttribute(attr, propValue);
      else document.documentElement.removeAttribute(attr);
    });
  });
}

function coerceStyleMap(raw) {
  if (!raw || typeof raw !== 'object') return {};
  var out = {};
  for (var k in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    var v = raw[k];
    if (v == null) continue;
    out[k] = String(v).trim();
  }
  return out;
}

/** Restores per-blue-box color / size from tenant `webTextColors` + `webTextFontSizes`.
 * Palette-only patches omit those maps — use native session overrides when set (including `{}`). */
function applyWebTextStyles(tenant) {
  var tenantObj = tenant || {};
  var hasColorMap = Object.prototype.hasOwnProperty.call(tenantObj, 'webTextColors');
  var hasSizeMap = Object.prototype.hasOwnProperty.call(tenantObj, 'webTextFontSizes');
  var colors;
  var sizes;
  if (hasColorMap) {
    colors = coerceStyleMap(tenantObj.webTextColors);
    var nativeTxt = window.__bkNativeTextColors;
    if (nativeTxt) {
      Object.keys(nativeTxt).forEach(function(k) {
        var v = nativeTxt[k];
        if (v && String(v).charAt(0) === '#') colors[k] = v;
      });
    }
  } else if (window.__bkNativeTextColors != null) {
    colors = coerceStyleMap(window.__bkNativeTextColors);
    hasColorMap = true;
  } else {
    colors = window.__bkCachedWebTextColors || {};
  }
  if (hasSizeMap) {
    sizes = coerceStyleMap(tenantObj.webTextFontSizes);
    var nativeSz = window.__bkNativeTextFontSizes;
    if (nativeSz) {
      Object.keys(nativeSz).forEach(function(k) {
        var v = nativeSz[k];
        if (v != null && String(v).trim() !== '') sizes[k] = String(v).trim();
      });
    }
  } else if (window.__bkNativeTextFontSizes != null) {
    sizes = coerceStyleMap(window.__bkNativeTextFontSizes);
    hasSizeMap = true;
  } else {
    sizes = window.__bkCachedWebTextFontSizes || {};
  }
  if (hasColorMap) window.__bkCachedWebTextColors = colors;
  if (hasSizeMap) window.__bkCachedWebTextFontSizes = sizes;
  if (!hasColorMap && !hasSizeMap && !Object.keys(colors).length && !Object.keys(sizes).length) return;
  [].forEach.call(document.querySelectorAll('[data-edit-key]'), function(el) {
    var k = el.getAttribute('data-edit-key') || '';
    if (isSheetOnlyEditKey(k)) return;
    var col = colors[k];
    if (col && col.charAt(0) === '#') {
      try { el.style.setProperty('color', col, 'important'); }
      catch (e) { el.style.color = col; }
    } else if (hasColorMap) {
      el.style.removeProperty('color');
    }
    var sz = parseInt(sizes[k], 10);
    if (sz >= 10 && sz <= 96) {
      try { el.style.setProperty('font-size', sz + 'px', 'important'); }
      catch (e2) { el.style.fontSize = sz + 'px'; }
    } else if (hasSizeMap) {
      el.style.removeProperty('font-size');
    }
  });
}

function applySidebarIconColor(tenant, isBookPath, isGalleryPath) {
  var iconColor = '';

  if (isBookPath && tenant.sidebarIconColorBooking) {
    iconColor = tenant.sidebarIconColorBooking;
  } else if (!isBookPath && !isGalleryPath && tenant.sidebarIconColorHome) {
    iconColor = tenant.sidebarIconColorHome;
  }

  if (!iconColor) {
    var tc = tenantColors(tenant);
    if (isGalleryPath) {
      iconColor = (usesThemedChrome(tenant) || isClassicTheme(tenant))
        ? (isBladeTheme(tenant) ? tc.accent : (usesAccentSidebarDrawer(tenant) ? tc.accent : tc.fg))
        : '#FFFFFF';
    } else if (isBookPath) {
      iconColor = usesThemedChrome(tenant)
        ? (isBladeTheme(tenant) ? tc.accent : (usesAccentSidebarDrawer(tenant) ? tc.accent : tc.fg))
        : '#000000';
    } else if (usesAccentSidebarDrawer(tenant)) {
      iconColor = tc.accent;
    } else if (usesThemedChrome(tenant)) {
      iconColor = isBladeTheme(tenant) ? tc.accent : tc.fg;
    } else {
      var bg = tc.bg.toUpperCase().replace(/\s/g, '');
      iconColor = (bg === '#FFFFFF' || bg === '#FFF') ? '#000000' : '#FFFFFF';
    }
  }

  var btns = document.querySelectorAll('.tattoo-nav-menu');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    b.style.color = iconColor;
    if (b.classList && b.classList.contains('blade-nav-menu-btn')) {
      b.style.setProperty('color', iconColor, 'important');
      b.style.setProperty('-webkit-text-fill-color', iconColor, 'important');
    }
  }
}

/** Invisible full-bleed button for section background color in app Quick edit. */
function bkColorBandHitButtonHtml() {
  return '<button type="button" class="bk-color-band-hit" aria-label="Edit section background"></button>';
}

/** Wrap band inner HTML with invisible hit target + passthrough content layer. */
function bkColorBandInnerWrap(innerHtml) {
  return bkColorBandHitButtonHtml() + '<div class="bk-band-content">' + innerHtml + '</div>';
}
