/* Charter template. */

function isCharterPlan(tenant) {
  var p = String((tenant && tenant.subscriptionPlan) || '').toLowerCase();
  return p === 'charter' || p === 'charters';
}

function isCharterTheme(tenant) {
  if (!tenant) return false;
  if (isCharterPlan(tenant)) return true;
  if (String(tenant.resolvedWebThemeId || tenant.webThemeId || '') === 'charter-v1') return true;
  return String(tenant.industry || '') === 'charters';
}

function charterHeroHasPhoto(el) {
  return !!(el && el.querySelector && el.querySelector('img[data-edit-key="heroImage"]'));
}

function charterHeroPhotoUrl(el, tenant) {
  var u = resolvedHeroImageUrl(tenant);
  if (u) return u;
  var img = el && el.querySelector && el.querySelector('img[data-edit-key="heroImage"]');
  return (img && img.getAttribute('src')) ? String(img.getAttribute('src')).trim() : '';
}

/** Photo lives only on `.charter-hero-media`. Never stamp `background` on the keyed section. */
function stampCharterHeroPhotoFill(el, url) {
  if (!url) return;
  var hero = el && el.classList && el.classList.contains('charter-hero')
    ? el
    : (el && el.closest ? el.closest('.charter-hero') : null);
  if (!hero) hero = document.querySelector('.charter-hero');
  var media = (hero && hero.querySelector) ? hero.querySelector('.charter-hero-media') : null;
  if (!media && el && el.classList && el.classList.contains('charter-hero-media')) media = el;
  if (hero) {
    try { hero.style.removeProperty('background'); } catch (e0) {}
    try { hero.style.removeProperty('background-image'); } catch (e1) {}
  }
  if (!media) return;
  var safe = String(url).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  var cssUrl = 'url("' + safe + '")';
  try { media.style.removeProperty('background'); } catch (e2) {}
  media.style.setProperty('background-image', cssUrl, 'important');
  media.style.setProperty('background-size', 'cover', 'important');
  media.style.setProperty('background-position', 'center', 'important');
  media.style.setProperty('background-repeat', 'no-repeat', 'important');
}

function paintCharterHeroSurface(el, tenant, col, tc) {
  if (!el) return;
  try { el.style.removeProperty('background'); } catch (e0) {}
  try { el.style.removeProperty('background-image'); } catch (e1) {}
  var url = charterHeroPhotoUrl(el, tenant);
  if (url) {
    stampCharterHeroPhotoFill(el, url);
    try { el.style.setProperty('color', '#fff', 'important'); } catch (e2) {}
    el.style.setProperty('--bk-about-fg', '#fff');
    return;
  }
  var sid = el.getAttribute('data-bk-color-surface') || 'hero';
  var fill = (col && col.charAt(0) === '#') ? col : null;
  if (!fill && tc) fill = roleBgForColorSurface(sid, tc);
  if (!fill) fill = roleBgFromLiveCss(sid);
  if (fill) {
    try { el.style.setProperty('background-color', fill, 'important'); }
    catch (e3) { el.style.backgroundColor = fill; }
    applyKeyedCharterSurfaceInk(el, 'charter.hero', fill);
  } else {
    el.style.removeProperty('background-color');
    clearKeyedCharterSurfaceInk(el, 'charter.hero');
  }
}

/** Mount the selected hero photo on the section (behind search). */
function applyCharterHeroPhoto(tenant) {
  var hero = document.querySelector('.charter-hero');
  var media = document.querySelector('.charter-hero-media');
  var url = resolvedHeroImageUrl(tenant) || charterHeroPhotoUrl(hero, tenant);
  if (!url) return;
  if (hero) stampCharterHeroPhotoFill(hero, url);
  if (media) {
    var img = media.querySelector('img[data-edit-key="heroImage"]');
    if (!img) {
      var slot = media.querySelector('.charter-hero-slot');
      img = document.createElement('img');
      img.setAttribute('data-edit-key', 'heroImage');
      img.alt = '';
      if (slot && slot.parentNode) slot.parentNode.replaceChild(img, slot);
      else media.insertBefore(img, media.firstChild);
    }
    img.src = url;
  }
}

function isCharterSurfaceKey(key) {
  return !!(key && String(key).indexOf('charter.') === 0);
}

/** Charter keyed bands/cards: ink + CSS vars so children follow the painted fill.
 * Home Shop / Featured bands use non-!important ink so section copy
 * (`wc.charter.shopHeading`, `wc.charter.featuredLabel`, etc.) stay independently editable via webTextColors. */
function applyKeyedCharterSurfaceInk(el, key, bgCol) {
  if (!el || !isCharterSurfaceKey(key) || !bgCol || bgCol.charAt(0) !== '#') return;
  var fg = contrastingInkHex(bgCol);
  if (key === 'charter.shop' || key === 'charter.featured') {
    el.style.color = fg;
  } else {
    try { el.style.setProperty('color', fg, 'important'); }
    catch (e) { el.style.color = fg; }
  }
  el.style.setProperty('--charter-bg', bgCol);
  el.style.setProperty('--charter-ink', fg);
  el.style.setProperty('--charter-muted', rgbaFromHex(fg, 0.58));
  el.style.setProperty('--charter-line', rgbaFromHex(fg, 0.10));
  el.style.setProperty('--charter-surface', bgCol);
  if (key === 'charter.hero') {
    el.style.setProperty('--bk-about-bg', bgCol);
    el.style.setProperty('--bk-about-fg', fg);
  }
  if (key === 'charter.bookingCard') {
    el.style.setProperty('--bk-input-bg', 'color-mix(in srgb, ' + fg + ' 7%, transparent)');
  }
}

function clearKeyedCharterSurfaceInk(el, key) {
  if (!el || !isCharterSurfaceKey(key)) return;
  el.style.removeProperty('color');
  el.style.removeProperty('--charter-bg');
  el.style.removeProperty('--charter-ink');
  el.style.removeProperty('--charter-muted');
  el.style.removeProperty('--charter-line');
  el.style.removeProperty('--charter-surface');
  if (key === 'charter.hero') {
    el.style.removeProperty('--bk-about-bg');
    el.style.removeProperty('--bk-about-fg');
  }
  if (key === 'charter.bookingCard') el.style.removeProperty('--bk-input-bg');
}

/** Charter: unkeyed page/nav/footer/bands follow palette tokens. Keyed spots are owned by applyWebSurfaceColors. */
function applyCharterHomeBandColors(tenant) {
  if (!isCharterTheme(tenant)) return;
  var c = tenantColors(tenant);
  applyEmptyImageSlotColors(tenant);
  function skipKeyed(el) {
    return !!(el && (el.getAttribute('data-bk-surface-key') || '').trim());
  }
  [].forEach.call(document.querySelectorAll('.charter-page'), function(el) {
    if (skipKeyed(el)) return;
    el.style.background = c.bg;
    el.style.color = c.fg;
    el.style.setProperty('--charter-bg', c.bg);
    el.style.setProperty('--charter-ink', c.fg);
    el.style.setProperty('--charter-surface', c.card);
    el.style.setProperty('--charter-accent', c.accent);
    el.style.setProperty('--charter-accent-ink', c.accentFg);
    el.style.setProperty('--charter-muted', rgbaFromHex(c.fg, 0.58));
    el.style.setProperty('--charter-line', rgbaFromHex(c.fg, 0.10));
  });
  [].forEach.call(document.querySelectorAll('.charter-nav'), function(el) {
    if (skipKeyed(el)) return;
    el.style.background = c.bg;
    el.style.color = c.fg;
    el.style.setProperty('--charter-bg', c.bg);
    el.style.setProperty('--charter-ink', c.fg);
  });
  [].forEach.call(document.querySelectorAll('.charter-page [data-bk-color-surface]'), function(el) {
    if (el.tagName === 'NAV') return;
    if (skipKeyed(el)) return;
    if (el.closest && el.closest('[data-bk-surface-key]')) return;
    var sid = el.getAttribute('data-bk-color-surface') || 'page';
    if (sid === 'hero') return;
    var s = tenantSurfaceColors(tenant, sid);
    el.style.setProperty('--charter-bg', s.bg);
    el.style.setProperty('--charter-ink', s.fg);
    el.style.setProperty('--charter-muted', rgbaFromHex(s.fg, 0.58));
    el.style.setProperty('--charter-line', rgbaFromHex(s.fg, 0.10));
    el.style.setProperty('--charter-surface', c.card);
    el.style.setProperty('--charter-accent', c.accent);
    el.style.setProperty('--charter-accent-ink', c.accentFg);
  });
  [].forEach.call(document.querySelectorAll('.charter-footer'), function(el) {
    if (skipKeyed(el)) return;
    el.style.background = c.aboutBg;
    el.style.color = c.aboutFg;
    el.style.setProperty('--charter-bg', c.aboutBg);
    el.style.setProperty('--charter-ink', c.aboutFg);
    el.style.setProperty('--charter-muted', rgbaFromHex(c.aboutFg, 0.65));
    el.style.setProperty('--charter-line', rgbaFromHex(c.aboutFg, 0.16));
    el.style.borderTopColor = rgbaFromHex(c.aboutFg, 0.16);
  });
}

/** Paint Charter /book root + shell so `charter.bookingPage` stays visible (nav stays `charter.nav`). */
function applyCharterBookingPageRootFill(col) {
  function paint(el) {
    if (!el) return;
    if (col && String(col).charAt(0) === '#') {
      try { el.style.setProperty('background', col, 'important'); }
      catch (e) { el.style.background = col; }
    } else if (col) {
      try { el.style.setProperty('background', col, 'important'); }
      catch (e2) { el.style.background = col; }
    } else {
      el.style.removeProperty('background');
    }
  }
  [].forEach.call(document.querySelectorAll('.charter-page:has(.booking-shell)'), function(root) {
    paint(root);
    [].forEach.call(root.querySelectorAll('.booking-shell'), paint);
    [].forEach.call(root.querySelectorAll('.booking-page-band'), paint);
  });
}

/** Charter-only per-band paint key (`webSurfaceColors`). */
function charterBkSurfaceKeyAttr(tenant, key) {
  if (!tenant || !key) return '';
  if (!isCharterTheme(tenant)) return '';
  return ' data-bk-surface-key="' + esc(key) + '"';
}

/** Charter card/block paint target — role `card` plus a unique key so fills never share tokens. */
function charterBkCardSurfaceAttrs(tenant, key) {
  if (!tenant || !key || !isCharterTheme(tenant)) return '';
  return ' data-bk-color-surface="card"' + charterBkSurfaceKeyAttr(tenant, key) + ' data-bk-band-tappable';
}

/** Charter route canvas — flexes to the footer; leftover gap is this key, not header. */
function charterRouteCanvasOpen(tenant, key) {
  return '<div class="charter-route-canvas"' + charterBandAttrs(tenant, 'page', key) + '>';
}

/** Pre-wrapped route canvas — one keyed band for all inner content (e.g. /charters card). */
function charterRouteCanvasHtml(tenant, key, innerHtml, surfaceRole) {
  return charterKeyedBandHtml(tenant, key, surfaceRole || 'page', 'charter-route-canvas', innerHtml);
}

/** Hero band — pre-wrapped so Quick Edit never restructures media + inner + search. */
function charterHeroSectionHtml(tenant, innerHtml) {
  if (!tenant || !isCharterTheme(tenant)) {
    return '<section class="charter-hero">' + innerHtml + '</section>';
  }
  return '<section class="charter-hero"' + charterBandAttrs(tenant, 'hero', 'charter.hero') + '>' +
    bkColorBandInnerWrap(innerHtml) + '</section>';
}

/** Hero search well — pre-wrapped; layout lives on .charter-search-grid (Edit never touches it). */
function charterHeroSearchBandHtml(tenant, innerHtml) {
  var gridInner = '<div class="charter-search-grid">' + innerHtml + '</div>';
  if (!tenant || !isCharterTheme(tenant)) {
    return '<div class="charter-search">' + gridInner + '</div>';
  }
  return '<div class="charter-search" data-bk-color-surface="card"' +
    charterBkSurfaceKeyAttr(tenant, 'charter.heroSearch') + ' data-bk-band-tappable>' +
    bkColorBandHitButtonHtml() +
    '<div class="bk-band-content">' + gridInner + '</div></div>';
}

/** Charter card/block — pre-wrapped hit + content so Edit never restructures layout children. */
function charterKeyedCardBandHtml(tenant, surfaceKey, className, innerHtml, extraAttrs, tag) {
  var elTag = tag || 'div';
  var cls = className || 'charter-blueprint';
  var extra = extraAttrs || '';
  if (!tenant || !surfaceKey || !isCharterTheme(tenant)) {
    return '<' + elTag + ' class="' + cls + '"' + extra + '>' + innerHtml + '</' + elTag + '>';
  }
  /* Never nest a <button> inside <a> — Safari drops link activation. */
  /* Quote card is a unified Quick-edit target (photo + copy) — no band hit overlay. */
  var hit = (elTag === 'a' || surfaceKey === 'charter.quoteCard') ? '' : bkColorBandHitButtonHtml();
  return '<' + elTag + ' class="' + cls + '" data-bk-color-surface="card"' +
    charterBkSurfaceKeyAttr(tenant, surfaceKey) + ' data-bk-band-tappable' + extra + '>' +
    hit +
    '<div class="bk-band-content">' + innerHtml + '</div></' + elTag + '>';
}

/** Charter keyed band (non-blueprint) — filters row, etc. */
function charterKeyedBandHtml(tenant, surfaceKey, surfaceRole, className, innerHtml, extraAttrs, tag) {
  var elTag = tag || 'div';
  var cls = className || '';
  var role = surfaceRole || 'page';
  var extra = extraAttrs || '';
  var classAttr = cls ? ' class="' + cls + '"' : '';
  if (!tenant || !surfaceKey || !isCharterTheme(tenant)) {
    return '<' + elTag + classAttr + extra + '>' + innerHtml + '</' + elTag + '>';
  }
  return '<' + elTag + classAttr + ' data-bk-color-surface="' + role + '"' +
    charterBkSurfaceKeyAttr(tenant, surfaceKey) + ' data-bk-band-tappable' + extra + '>' +
    bkColorBandHitButtonHtml() +
    '<div class="bk-band-content">' + innerHtml + '</div></' + elTag + '>';
}

function tenantShowChartersPage(tenant) {
  return tenant.showChartersPage !== false;
}

function charterBandAttrs(tenant, surface, key) {
  var attrs = ' data-bk-color-surface="' + (surface || 'page') + '" data-bk-band-tappable';
  if (key) attrs += charterBkSurfaceKeyAttr(tenant, key);
  return attrs;
}

function charterLocHtml(tenant) {
  var area = (tenant.serviceArea || '').toString().trim();
  return area
    ? '<span class="charter-loc" data-edit-key="serviceArea">' + esc(area) + '</span>'
    : '<span class="charter-loc" data-edit-key="serviceArea" data-bk-empty-slot="1"></span>';
}

function charterNavHtml(tenant, active) {
  var base = tenantBaseUrl(tenant);
  function link(href, label, key, copyKey) {
    var cls = active === key ? ' class="is-active"' : '';
    return '<a href="' + href + '"' + cls + '>' + wcSpan(tenant, copyKey, label) + '</a>';
  }
  return '<nav class="charter-nav"' + charterBandAttrs(tenant, 'page', 'charter.nav') + '>' +
    '<a href="' + base + '/home" class="charter-brand">' + siteNameSpan(tenant, 'Harbor Charters', 'displayName.charter.nav') + '</a>' +
    '<div class="charter-nav-links">' +
      (tenantShowChartersPage(tenant) ? link(base + '/charters', 'Charters', 'charters', 'wc.charter.navCharters') : '') +
      (tenantShowHowItWorksPage(tenant) ? link(base + '/how-it-works', 'How it works', 'how', 'wc.charter.navHow') : '') +
      (tenantShowShopPage(tenant) ? link(base + '/shop', 'Shop', 'shop', 'wc.charter.navShop') : '') +
      (tenantShowAboutPage(tenant) ? link(base + '/about', 'About', 'about', 'wc.charter.navAbout') : '') +
    '</div>' +
    (tenantShowBookPage(tenant) && tenantShowChartersPage(tenant)
      ? '<a class="charter-btn" href="' + base + '/charters" data-cta-key="wc.charter.navBook">' + wcSpan(tenant, 'wc.charter.navBook', 'Book now') + '</a>'
      : '') +
    '<button type="button" class="tattoo-nav-menu charter-nav-menu" aria-label="Menu">' +
      hamburgerMenuSvg() +
    '</button>' +
    '</nav>' +
    charterSidebarHtml(tenant);
}

function charterInstagramHandle(tenant) {
  var raw = String((tenant && tenant.instagramHandle) || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^@+/, '');
  var fromUrl = raw.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (fromUrl) raw = fromUrl[1];
  raw = raw.split(/[/?#]/)[0].replace(/\/+$/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(raw)) return '';
  return raw;
}

function charterInstagramUrl(tenant) {
  var handle = charterInstagramHandle(tenant);
  return handle ? ('https://www.instagram.com/' + encodeURIComponent(handle)) : '';
}

function charterInstagramLinkHtml(tenant, className) {
  var handle = charterInstagramHandle(tenant);
  var url = charterInstagramUrl(tenant);
  if (!handle || !url) return '';
  var cls = className ? (' class="' + className + '"') : '';
  return '<a href="' + esc(url) + '"' + cls + ' target="_blank" rel="noopener noreferrer">@' +
    esc(handle) + '</a>';
}

function charterFooterHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var year = new Date().getFullYear();
  var igHtml = charterInstagramLinkHtml(tenant, 'charter-footer-ig');
  return '<footer class="charter-footer"' + charterBandAttrs(tenant, 'about', 'charter.footer') + '>' +
    '<a href="' + base + '/home" class="charter-brand">' + siteNameSpan(tenant, 'Harbor Charters') + '</a>' +
    (tenantShowChartersPage(tenant) ? '<a href="' + base + '/charters">' + wcSpan(tenant, 'wc.charter.footerCharters', 'Charters') + '</a>' : '') +
    (tenantShowHowItWorksPage(tenant) ? '<a href="' + base + '/how-it-works">' + wcSpan(tenant, 'wc.charter.footerHow', 'How it works') + '</a>' : '') +
    (tenantShowShopPage(tenant) ? '<a href="' + base + '/shop">' + wcSpan(tenant, 'wc.charter.footerShop', 'Shop') + '</a>' : '') +
    (tenantShowAboutPage(tenant) ? '<a href="' + base + '/about">' + wcSpan(tenant, 'wc.charter.footerAbout', 'About') + '</a>' : '') +
    (tenantShowBookPage(tenant) && tenantShowChartersPage(tenant) ? '<a href="' + base + '/charters">' + wcSpan(tenant, 'wc.charter.footerBook', 'Book now') + '</a>' : '') +
    igHtml +
    charterLocHtml(tenant) +
    '<span class="copy">&copy; ' + year + ' ' +
      siteNameSpan(tenant, 'Harbor Charters', 'displayName.charter.footerLegal') + '</span>' +
    '</footer>';
}

function charterSidebarHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  return '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
}

function charterPriceLabel(s) {
  if (!s) return '';
  if (typeof s.priceCents === 'number' && s.priceCents > 0) return '$' + Math.round(s.priceCents / 100);
  if (typeof s.price === 'number' && s.price > 0) return '$' + Math.round(s.price);
  return (s.bladePriceCaption || s.priceLabel || '').toString();
}

function charterServicePriceCents(s) {
  if (!s) return 0;
  if (typeof s.priceCents === 'number' && s.priceCents > 0) return s.priceCents;
  if (typeof s.price === 'number' && s.price > 0) return Math.round(s.price * 100);
  return 0;
}

function charterServiceBoatDisplay(tenant, s) {
  var ids = charterServiceBoatIds(s);
  for (var i = 0; i < ids.length; i++) {
    var b = charterBoatById(tenant, ids[i]);
    if (!b) continue;
    var n = String(b.name || '').trim();
    if (n) return 'Aboard the ' + n;
    var t = String(b.boatType || b.type || '').trim();
    if (t) return 'Aboard the ' + t;
  }
  return '';
}

function charterBrowseRatingMeta(tenant, s) {
  if (s && typeof s.rating === 'number' && isFinite(s.rating)) {
    return { rating: s.rating, count: Number(s.reviewCount) || 0 };
  }
  var revs = (tenant && tenant.reviews) || [];
  if (!revs.length) return null;
  var sum = 0;
  var n = 0;
  for (var r = 0; r < revs.length; r++) {
    var st = Number(revs[r].stars || revs[r].rating);
    if (st > 0) { sum += st; n += 1; }
  }
  if (!n) return null;
  return { rating: sum / n, count: revs.length };
}

function charterDurationLabel(s) {
  if (!s || !s.durationMinutes) return '';
  var h = Number(s.durationMinutes) / 60;
  if (h === 0.5) return '30 min';
  if (h === Math.floor(h)) return h + ' hrs';
  return h.toFixed(1) + ' hrs';
}

function charterTripHref(tenant, s, dateIso) {
  return charterSearchHref(tenant, {
    slug: (s && s.slug) ? s.slug : '',
    date: dateIso != null ? dateIso : undefined
  });
}

function charterQueryDateIso() {
  return charterSearchQuery().date;
}

function charterParseTimeToMin(raw) {
  var t = String(raw || '').trim();
  if (!t) return null;
  var hm = t.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    var h24 = parseInt(hm[1], 10);
    var m24 = parseInt(hm[2], 10);
    if (h24 >= 0 && h24 < 24 && m24 >= 0 && m24 < 60) return h24 * 60 + m24;
  }
  var am = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (am) {
    var h = parseInt(am[1], 10) % 12;
    if (/pm/i.test(am[3])) h += 12;
    return h * 60 + parseInt(am[2], 10);
  }
  return null;
}

function charterFormatMin(m) {
  if (typeof calendarFormatMin === 'function') return calendarFormatMin(m);
  var h = Math.floor(m / 60);
  var min = m % 60;
  var d = new Date(2000, 0, 1, h, min);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function charterSearchQuery() {
  var out = { date: '', time: '', people: 0, duration: 0, boat: '' };
  try {
    var q = new URLSearchParams(location.search || '');
    var date = String(q.get('date') || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.date = date;
    out.time = String(q.get('time') || '').trim();
    var p = parseInt(q.get('people') || '0', 10);
    if (p > 0) out.people = p;
    var d = parseInt(q.get('duration') || '0', 10);
    if (d > 0) out.duration = d;
    out.boat = String(q.get('boat') || '').trim();
  } catch (e) {}
  return out;
}

function charterSearchHref(tenant, extra) {
  extra = extra || {};
  var q = charterSearchQuery();
  if (extra.date != null) q.date = extra.date;
  if (extra.time != null) q.time = extra.time;
  if (extra.people != null) q.people = extra.people;
  if (extra.duration != null) q.duration = extra.duration;
  if (extra.boat != null) q.boat = extra.boat;
  if (extra.slug) {
    /* trip detail */
  }
  var params = [];
  if (q.date) params.push('date=' + encodeURIComponent(q.date));
  if (q.time) params.push('time=' + encodeURIComponent(q.time));
  if (q.people) params.push('people=' + encodeURIComponent(String(q.people)));
  if (q.duration) params.push('duration=' + encodeURIComponent(String(q.duration)));
  if (q.boat) params.push('boat=' + encodeURIComponent(q.boat));
  var path = extra.slug
    ? (tenantBaseUrl(tenant) + '/charters/' + encodeURIComponent(extra.slug))
    : (tenantBaseUrl(tenant) + '/charters');
  return params.length ? (path + '?' + params.join('&')) : path;
}

function charterBookHref(tenant, service, extra) {
  var root = tenantBaseUrl(tenant).replace(/\/$/, '');
  var path = tenantShowBookPage(tenant)
    ? (root + '/book' + (service && service.slug ? ('/' + encodeURIComponent(service.slug)) : ''))
    : (root + '/charters');
  var withQuery = charterSearchHref(tenant, extra || {});
  var q = withQuery.indexOf('?') >= 0 ? withQuery.slice(withQuery.indexOf('?')) : '';
  return path + q;
}

function charterMinToHHmm(m) {
  var h = Math.floor(Number(m) / 60);
  var min = Number(m) % 60;
  return (h < 10 ? '0' : '') + h + ':' + (min < 10 ? '0' : '') + min;
}

/** Earliest departure today: the next clock hour in the captain's time zone (12:15 → 1:00). */
function charterTenantTz(tenant) {
  var tz = tenant && tenant.timeZone ? String(tenant.timeZone).trim() : '';
  return tz || 'America/New_York';
}

function charterPartsInTz(date, tz) {
  try {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    var bag = {};
    fmt.formatToParts(date).forEach(function(p) {
      if (p.type !== 'literal') bag[p.type] = p.value;
    });
    return {
      year: Number(bag.year),
      month: Number(bag.month),
      day: Number(bag.day),
      hour: Number(bag.hour),
      minute: Number(bag.minute)
    };
  } catch (e) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes()
    };
  }
}

function charterIsoInTz(date, tz) {
  var p = charterPartsInTz(date, tz);
  var m = String(p.month).padStart(2, '0');
  var d = String(p.day).padStart(2, '0');
  return p.year + '-' + m + '-' + d;
}

function charterLeadCutoffMin(tenant) {
  var p = charterPartsInTz(new Date(), charterTenantTz(tenant));
  return (p.hour + 1) * 60;
}

function charterSlotTooSoon(date, startMin, tenant) {
  if (!date) return true;
  var tz = charterTenantTz(tenant);
  var todayIso = charterIsoInTz(new Date(), tz);
  var dateIso = calendarIsoDate(date);
  if (dateIso !== todayIso) return dateIso < todayIso;
  return startMin < charterLeadCutoffMin(tenant);
}

function charterApplyOccupancy(tenant, data) {
  var nowMs = (data && data.serverNowMs) || Date.now();
  tenant._charterServerNowMs = nowMs;
  tenant._charterHoldMinutes = (data && data.holdMinutes) || 15;
  tenant._charterOccupancyFailed = false;
  tenant._charterOccupancyReady = true;
  tenant._charterOccupancyFetchedAt = Date.now();
  tenant._charterOccupancyUntilIso = String((data && data.occupancyUntilIso) || '').trim();
  tenant._charterOccupancyTruncated = !!(data && data.truncated);
  var slots = (data && data.slots) || [];
  tenant._charterOccupancy = slots.filter(function(o) {
    var until = Number(o.holdUntilMs) || 0;
    if (until > 0 && until <= nowMs) return false;
    return true;
  });
}

function charterMarkOccupancyFailed(tenant) {
  tenant._charterOccupancyFailed = true;
  tenant._charterOccupancyReady = true;
  tenant._charterOccupancyFetchedAt = 0;
  tenant._charterOccupancy = [];
  tenant._charterOccupancyUntilIso = '';
}

function charterOccupancyIsFresh(tenant) {
  if (!tenant || tenant._charterOccupancyFailed) return false;
  if (!tenant._charterOccupancyReady) return false;
  var at = Number(tenant._charterOccupancyFetchedAt) || 0;
  return at > 0 && (Date.now() - at) < CHARTER_OCCUPANCY_TTL_MS;
}

function charterInvalidateOccupancy(tenant) {
  if (!tenant) return;
  tenant._charterOccupancyReady = false;
  tenant._charterOccupancyFetchedAt = 0;
  tenant._charterOccupancyPromise = null;
}

function charterRefreshOccupancyUi() {
  if (typeof window.__charterOccupancyUiRefresh === 'function') {
    window.__charterOccupancyUiRefresh();
  }
}

function charterPollOccupancy() {
  if (document.visibilityState !== 'visible') return;
  var t = window.__charterActiveTenant;
  if (!t) return;
  charterLoadOccupancy(t, { silent: true }).then(charterRefreshOccupancyUi).catch(function() {});
}

function charterBindOccupancyLifecycle(tenant, onReload) {
  window.__charterActiveTenant = tenant;
  window.__charterOccupancyUiRefresh = typeof onReload === 'function' ? onReload : null;
  if (!window.__charterOccupancyVisBound) {
    window.__charterOccupancyVisBound = true;
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState !== 'visible') return;
      charterPollOccupancy();
    });
  }
  if (!window.__charterOccupancyPoll) {
    window.__charterOccupancyPoll = setInterval(charterPollOccupancy, CHARTER_OCCUPANCY_POLL_MS);
  }
}

/** Shared public occupancy loader. Retry once; never expose slots after a failed load. */
function charterLoadOccupancy(tenant, opts) {
  var force = !!(opts && opts.force);
  var silent = !!(opts && opts.silent);
  if (!tenant || !tenant.slug || typeof functions === 'undefined') {
    if (tenant && !silent) charterMarkOccupancyFailed(tenant);
    return Promise.reject(new Error('Charter availability is unavailable.'));
  }
  if (!force && !silent && charterOccupancyIsFresh(tenant)) {
    return Promise.resolve(tenant._charterOccupancy || []);
  }
  if (tenant._charterOccupancyPromise) return tenant._charterOccupancyPromise;
  var keepShowing = silent && tenant._charterOccupancyReady && !tenant._charterOccupancyFailed;
  if (!keepShowing) {
    tenant._charterOccupancyReady = false;
    tenant._charterOccupancyFailed = false;
  }

  function request(remainingRetries) {
    return functions.httpsCallable('listPublicCharterOccupancy')({ tenantSlug: tenant.slug })
      .then(function(res) {
        charterApplyOccupancy(tenant, res && res.data);
        return tenant._charterOccupancy;
      })
      .catch(function(err) {
        if (remainingRetries > 0) {
          return new Promise(function(resolve) { setTimeout(resolve, 700); })
            .then(function() { return request(remainingRetries - 1); });
        }
        if (!keepShowing) charterMarkOccupancyFailed(tenant);
        throw err;
      });
  }

  tenant._charterOccupancyPromise = request(1).then(function(rows) {
    tenant._charterOccupancyPromise = null;
    return rows;
  }, function(err) {
    tenant._charterOccupancyPromise = null;
    throw err;
  });
  return tenant._charterOccupancyPromise;
}

function charterOccupancyUsableForDate(tenant, dateIso) {
  if (!tenant) return false;
  if (!tenant._charterOccupancyReady) return false;
  if (tenant._charterOccupancyFailed) return false;
  var until = String(tenant._charterOccupancyUntilIso || '').trim();
  if (until && dateIso && dateIso > until) return false;
  return true;
}

/** Hourly departures from Scheduling hours; last start must return by close. */
function charterOccupancySpanMin(service, durationMin) {
  var win = charterOccWindow(service, 0, durationMin);
  return Math.max(30, Number(win.occEndMin) || Number(durationMin) || 60);
}

function charterDepartureMinsForDay(day, durationMin, service, tenant) {
  if (!day || day.closed || !day.ranges || !day.ranges.length) return [];
  var span = charterOccupancySpanMin(service, durationMin);
  var seen = {};
  var out = [];
  var lastBook = charterLastBookingMin(tenant);
  for (var i = 0; i < day.ranges.length; i++) {
    var r = day.ranges[i];
    var first = Math.ceil(r.openMin / 60) * 60;
    if (first < r.openMin) first += 60;
    var last = span > 1440 ? r.closeMin : (r.closeMin - span);
    for (var t = first; t <= last && t <= r.closeMin; t += 60) {
      if (lastBook != null && t > lastBook) continue;
      if (t >= r.openMin && !seen[t]) {
        seen[t] = true;
        out.push(t);
      }
    }
  }
  out.sort(function(a, b) { return a - b; });
  return out;
}

function charterAddDaysIso(dateIso, days) {
  var d = charterDateFromIso(dateIso);
  if (!d) return '';
  d.setDate(d.getDate() + (Number(days) || 0));
  return calendarIsoDate(d);
}

function charterOccWindow(service, startMin, durMin) {
  var dur = Math.max(30, Number(durMin) || 60);
  var svc = service || { durationMinutes: dur };
  if (!svc.durationMinutes) svc = Object.assign({}, svc, { durationMinutes: dur });
  var steps = charterResolveItinerary(svc);
  var minOff = 0;
  var maxOff = dur;
  var any = false;
  for (var i = 0; i < steps.length; i++) {
    var off = Number(steps[i].offsetMinutes);
    if (!isFinite(off)) continue;
    any = true;
    if (off < minOff) minOff = off;
    if (off > maxOff) maxOff = off;
  }
  if (!any) minOff = -30;
  return { occStartMin: startMin + minOff, occEndMin: startMin + Math.max(maxOff, dur) };
}

function charterOccSegments(dateIso, win) {
  var segs = [];
  if (!dateIso || !win) return segs;
  var date = dateIso;
  var start = Number(win.occStartMin);
  var end = Number(win.occEndMin);
  if (!isFinite(start) || !isFinite(end) || end <= start) return segs;
  if (start < 0) {
    var prev = charterAddDaysIso(date, -1);
    if (prev) segs.push({ date: prev, startMin: 1440 + start, endMin: 1440 });
    start = 0;
  }
  while (end > 1440) {
    segs.push({ date: date, startMin: start, endMin: 1440 });
    date = charterAddDaysIso(date, 1);
    start = 0;
    end -= 1440;
    if (!date) break;
  }
  if (date) segs.push({ date: date, startMin: start, endMin: end });
  return segs;
}

function charterStartInHours(day, startMin, durationMin, service) {
  if (!day || day.closed || !day.ranges || !day.ranges.length) return false;
  var span = charterOccupancySpanMin(service, durationMin);
  var end = startMin + span;
  for (var i = 0; i < day.ranges.length; i++) {
    var r = day.ranges[i];
    if (startMin < r.openMin || startMin > r.closeMin) continue;
    if (span > 1440 || end <= r.closeMin) return true;
  }
  return false;
}

function charterSegmentsHitBlocks(tenant, segs) {
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i];
    var d = charterDateFromIso(seg.date);
    if (!d) continue;
    if (typeof calendarIsFullDayBlocked === 'function' && calendarIsFullDayBlocked(tenant, d)) return true;
    var blocks = typeof calendarPartialBlocksForDay === 'function' ? calendarPartialBlocksForDay(tenant, d) : [];
    for (var b = 0; b < blocks.length; b++) {
      if (seg.startMin < blocks[b].endMin && blocks[b].startMin < seg.endMin) return true;
    }
  }
  return false;
}

function charterHasFleet(tenant) {
  var boats = (tenant && Array.isArray(tenant.charterBoats)) ? tenant.charterBoats : [];
  for (var i = 0; i < boats.length; i++) {
    if (boats[i] && String(boats[i].id || '').trim()) return true;
  }
  return false;
}

function charterNoFleetMessage() {
  return "Charters aren't available to book yet. Check back soon.";
}

function charterEligibleBoats(tenant, service, partySize, boatFilterId) {
  var boats = (tenant && Array.isArray(tenant.charterBoats)) ? tenant.charterBoats.slice() : [];
  boats = boats.filter(function(b) { return b && String(b.id || '').trim(); });
  var ids = charterServiceBoatIds(service);
  if (ids.length) {
    var want = {};
    ids.forEach(function(id) { want[id] = true; });
    boats = boats.filter(function(b) { return want[String(b.id)]; });
  }
  var filter = String(boatFilterId || '').trim();
  if (filter) boats = boats.filter(function(b) { return String(b.id) === filter; });
  var people = Number(partySize) || 0;
  if (people > 0) {
    boats = boats.filter(function(b) { return Number(b.maxPeople) >= people; });
  }
  boats.sort(function(a, b) {
    var ca = Number(a.maxPeople) || 0;
    var cb = Number(b.maxPeople) || 0;
    if (ca !== cb) return ca - cb;
    return String(a.id).localeCompare(String(b.id));
  });
  return boats;
}

function charterSlotHasFreeBoat(tenant, occupancy, dateIso, startMin, durMin, service, people, boatFilterId) {
  var eligible = charterEligibleBoats(tenant, service, people, boatFilterId);
  if (!eligible.length) return false;
  var segs = charterOccSegments(dateIso, charterOccWindow(service, startMin, durMin));
  var list = occupancy || [];
  var locationWide = charterBookByLocation(tenant);
  function blocked(boatId) {
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      var os = Number(o.startMin);
      var oe = Number(o.endMin);
      if (!isFinite(os) || !isFinite(oe)) continue;
      for (var s = 0; s < segs.length; s++) {
        if (String(o.date || '') !== String(segs[s].date || '')) continue;
        if (!(segs[s].startMin < oe && segs[s].endMin > os)) continue;
        var bid = String(o.boatId || '');
        if (locationWide || !bid || bid === boatId) return true;
      }
    }
    return false;
  }
  for (var j = 0; j < eligible.length; j++) {
    if (!blocked(String(eligible[j].id))) return true;
  }
  return false;
}

function charterOpenStartsForTrip(tenant, date, durationMin, opts) {
  opts = opts || {};
  var out = [];
  if (!date || charterIsPastDay(date, tenant)) return out;
  if (typeof calendarIsFullDayBlocked === 'function' && calendarIsFullDayBlocked(tenant, date)) return out;
  var day = calendarDaySchedule(tenant, date);
  if (!day || day.closed || !day.ranges || !day.ranges.length) return out;
  var people = Number(opts.people) || 0;
  var maxP = Number(opts.maxPeople) > 0 ? Number(opts.maxPeople) : charterMaxPeople(tenant);
  if (people > 0 && maxP > 0 && people > maxP) return out;
  var dur = Math.max(30, Number(durationMin) || 60);
  var occupancy = opts.occupancy || tenant._charterOccupancy || [];
  var dateIso = calendarIsoDate(date);
  if (!charterOccupancyUsableForDate(tenant, dateIso)) return out;
  var clocks = charterDepartureMinsForDay(day, dur, opts.service, tenant);
  for (var i = 0; i < clocks.length; i++) {
    var t = clocks[i];
    if (!charterStartInHours(day, t, dur, opts.service)) continue;
    if (charterSlotTooSoon(date, t, tenant)) continue;
    var segs = charterOccSegments(dateIso, charterOccWindow(opts.service, t, dur));
    if (charterSegmentsHitBlocks(tenant, segs)) continue;
    if (!charterSlotHasFreeBoat(tenant, occupancy, dateIso, t, dur, opts.service, people, opts.boatFilterId)) continue;
    out.push(t);
  }
  return out;
}

function charterBoatById(tenant, id) {
  var want = String(id || '').trim();
  if (!want) return null;
  var boats = (tenant && Array.isArray(tenant.charterBoats)) ? tenant.charterBoats : [];
  for (var i = 0; i < boats.length; i++) {
    if (String(boats[i].id || '') === want) return boats[i];
  }
  return null;
}

function charterBoatLabel(boat) {
  if (!boat) return '';
  var t = String(boat.boatType || boat.type || 'Boat').trim() || 'Boat';
  var n = Number(boat.maxPeople) || 0;
  return n > 0 ? (t + ' · ' + n + (n === 1 ? ' person' : ' people')) : t;
}

function charterServiceBoatIds(service) {
  if (!service) return [];
  if (Array.isArray(service.boatIds) && service.boatIds.length) {
    return service.boatIds.map(function(id) { return String(id || '').trim(); }).filter(Boolean);
  }
  var one = String(service.boatId || '').trim();
  return one ? [one] : [];
}

function charterMaxPeopleForTrip(tenant, service) {
  var ids = charterServiceBoatIds(service);
  var m = 0;
  for (var i = 0; i < ids.length; i++) {
    var b = charterBoatById(tenant, ids[i]);
    var n = b ? Number(b.maxPeople) : 0;
    if (n > m) m = n;
  }
  return m > 0 ? m : charterMaxPeople(tenant);
}

function charterFleetSize(tenant) {
  var boats = (tenant && Array.isArray(tenant.charterBoats)) ? tenant.charterBoats : [];
  return boats.length;
}

function charterMaxPeople(tenant) {
  var boats = (tenant && Array.isArray(tenant.charterBoats)) ? tenant.charterBoats : [];
  var m = 0;
  for (var i = 0; i < boats.length; i++) {
    var n = Number(boats[i].maxPeople) || 0;
    if (n > m) m = n;
  }
  return m;
}

/** Home + /charters people filters — at least 12 choices (independent of fleet cap). */
function charterFilterPeopleMax(tenant) {
  return Math.max(charterMaxPeople(tenant) || 0, 12);
}

function charterPeopleOptionsHtml(tenant, selected, includeAny) {
  var maxGuests = charterFilterPeopleMax(tenant);
  var sel = parseInt(selected, 10) || 0;
  var html = includeAny ? '<option value="">Any party</option>' : '';
  for (var gp = 1; gp <= maxGuests; gp++) {
    html += '<option value="' + gp + '"' + (gp === sel ? ' selected' : '') + '>' +
      gp + (gp === 1 ? ' person' : ' people') + '</option>';
  }
  return html;
}

function charterOccupiedCount(occupancy, dateIso, startMin, durMin, service) {
  var list = occupancy || [];
  var segs = charterOccSegments(dateIso, charterOccWindow(service, startMin, durMin));
  var n = 0;
  for (var i = 0; i < list.length; i++) {
    var o = list[i];
    var os = Number(o.startMin);
    var oe = Number(o.endMin);
    if (!isFinite(os) || !isFinite(oe)) continue;
    for (var s = 0; s < segs.length; s++) {
      if (String(o.date || '') !== String(segs[s].date || '')) continue;
      if (segs[s].startMin < oe && segs[s].endMin > os) { n += 1; break; }
    }
  }
  return n;
}

function charterPayMode(tenant) {
  var t = tenant && tenant.workflow && tenant.workflow.confirmationType;
  t = String(t || '').trim().toLowerCase();
  if (t === 'pay_in_full') return 'full';
  if (t === 'deposit_to_confirm' || t === 'approve_and_deposit') return 'deposit';
  return 'request';
}

function charterBookByLocation(tenant) {
  var raw = '';
  if (tenant && tenant.workflow && tenant.workflow.charterBookBy != null) {
    raw = tenant.workflow.charterBookBy;
  } else if (tenant && tenant.charterBookBy != null) {
    raw = tenant.charterBookBy;
  }
  raw = String(raw || 'location').trim().toLowerCase();
  return raw !== 'boat' && raw !== 'boats' && raw !== 'fleet';
}

function charterBufferMinutes(tenant) {
  var n = Number(tenant && tenant.workflow && tenant.workflow.charterBufferMinutes);
  if (n === 0) return 0;
  if (!isFinite(n) || n < 0) return 30;
  return Math.min(240, Math.round(n));
}

function charterLastBookingMin(tenant) {
  var raw = tenant && tenant.workflow ? tenant.workflow.charterLastBookingMin : null;
  if (raw == null || raw === '') return null;
  var n = Number(raw);
  if (!isFinite(n) || n < 0) return null;
  return Math.min(24 * 60, Math.round(n));
}

function charterDepositAmount(tenant) {
  var n = tenant && tenant.workflow && tenant.workflow.depositAmount;
  n = Number(n);
  return (isFinite(n) && n > 0) ? n : 0;
}

function charterRequiresDeposit(tenant) {
  return charterPayMode(tenant) === 'deposit';
}

function charterDateFromIso(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function charterPrettyDateFromIso(iso) {
  var d = charterDateFromIso(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function charterDurationFilterKey(mins) {
  var n = Number(mins) || 0;
  if (n <= 0) return '';
  var h = Math.round(n / 60);
  if (h <= 2) return '2';
  if (h === 3) return '3';
  if (h === 4) return '4';
  if (h === 5) return '5';
  return '6plus';
}

function charterDurationBucket(mins) {
  return charterDurationFilterKey(mins);
}

function charterDefaultItinerary(durationMin) {
  var dur = Math.max(60, Number(durationMin) || 240);
  var mid = Math.max(30, Math.round(dur / 2 / 15) * 15);
  return [
    { offsetMinutes: -30, text: 'Meet at the marina, gear briefing' },
    { offsetMinutes: 0, text: 'Depart' },
    { offsetMinutes: mid, text: 'On the water' },
    { offsetMinutes: dur, text: 'Return to dock' }
  ];
}

function charterResolveItinerary(service) {
  var hasConfigured = !!(service && Object.prototype.hasOwnProperty.call(service, 'itinerary') && Array.isArray(service.itinerary));
  var raw = hasConfigured ? service.itinerary : [];
  var steps = [];
  for (var i = 0; i < raw.length; i++) {
    var row = raw[i] || {};
    var text = String(row.text || '').trim();
    if (!text) continue;
    var off = Number(row.offsetMinutes);
    steps.push({ offsetMinutes: isFinite(off) ? off : 0, text: text });
  }
  if (!hasConfigured) steps = charterDefaultItinerary(service && service.durationMinutes);
  return steps;
}

function charterItineraryClockLabel(startMin, offsetMin) {
  var wrap = function(m) {
    return ((m % 1440) + 1440) % 1440;
  };
  if (startMin == null || !isFinite(startMin)) {
    if (offsetMin === 0) return 'Depart';
    if (offsetMin < 0) return Math.abs(offsetMin) + ' min before';
    if (offsetMin % 60 === 0) return '+' + (offsetMin / 60) + ' hr';
    return '+' + offsetMin + ' min';
  }
  return charterFormatMin(wrap(startMin + offsetMin));
}

function charterItineraryListHtml(service, startHHmm) {
  var startMin = charterParseTimeToMin(startHHmm);
  var steps = charterResolveItinerary(service);
  return steps.map(function(st) {
    return '<div class="charter-itinerary-row"><span class="t">' +
      esc(charterItineraryClockLabel(startMin, st.offsetMinutes)) +
      '</span><span class="d">' + esc(st.text) + '</span></div>';
  }).join('');
}

function charterIsPastDay(date, tenant) {
  var dateIso = calendarIsoDate(date);
  if (!dateIso) return true;
  return dateIso < charterIsoInTz(new Date(), charterTenantTz(tenant));
}

/** Whether this trip can start on this calendar day (hours + blocks + duration + occupancy). */
function charterTripFitsDate(tenant, date, durationMin, opts) {
  opts = opts || {};
  if (!date || charterIsPastDay(date, tenant)) return false;
  if (typeof calendarIsFullDayBlocked === 'function' && calendarIsFullDayBlocked(tenant, date)) return false;
  var day = calendarDaySchedule(tenant, date);
  if (!day || day.closed || !day.ranges || !day.ranges.length) return false;
  var people = Number(opts.people) || 0;
  var maxP = Number(opts.maxPeople) > 0 ? Number(opts.maxPeople) : charterMaxPeople(tenant);
  if (people > 0 && maxP > 0 && people > maxP) return false;
  var dur = Math.max(30, Number(durationMin) || 60);
  if (opts.durationWanted > 0 && Math.abs(dur - opts.durationWanted) > 45) return false;
  var occupancy = opts.occupancy || tenant._charterOccupancy || [];
  var dateIso = calendarIsoDate(date);
  if (!charterOccupancyUsableForDate(tenant, dateIso)) return false;
  var wantStart = opts.startMin != null ? opts.startMin : null;
  function slotOk(t) {
    if (!charterStartInHours(day, t, dur, opts.service)) return false;
    if (charterSlotTooSoon(date, t, tenant)) return false;
    var segs = charterOccSegments(dateIso, charterOccWindow(opts.service, t, dur));
    if (charterSegmentsHitBlocks(tenant, segs)) return false;
    if (!charterSlotHasFreeBoat(tenant, occupancy, dateIso, t, dur, opts.service, people, opts.boatFilterId)) return false;
    return true;
  }
  var clocks = charterDepartureMinsForDay(day, dur, opts.service, tenant);
  if (wantStart != null) {
    return clocks.indexOf(wantStart) >= 0 && slotOk(wantStart);
  }
  for (var i = 0; i < clocks.length; i++) {
    if (slotOk(clocks[i])) return true;
  }
  return false;
}

function charterDayHasAnyTrip(tenant, services, date, opts) {
  var list = services || [];
  if (!list.length) {
    return typeof calendarSlotsForDay === 'function' && calendarSlotsForDay(tenant, date).length > 0;
  }
  for (var i = 0; i < list.length; i++) {
    if (charterTripFitsDate(tenant, date, list[i].durationMinutes, opts)) return true;
  }
  return false;
}

function charterDefaultSteps(tenant) {
  var steps = Array.isArray(tenant.studio12ProcessSteps) ? tenant.studio12ProcessSteps : [];
  var cleaned = steps.filter(function(s) {
    return s && (String(s.title || '').trim() || String(s.body || '').trim());
  });
  if (cleaned.length) {
    return cleaned.slice(0, 3).map(function(s, i) {
      return {
        n: String(i + 1).padStart(2, '0'),
        title: String(s.title || '').trim() || ('Step ' + (i + 1)),
        desc: String(s.body || s.desc || '').trim(),
        editTitle: 's12Process:' + i + ':title',
        editBody: 's12Process:' + i + ':body'
      };
    });
  }
  return [
    { n: '01', title: 'Search & compare', desc: 'Filter by trip type, price and timing to find the right charter.', editTitle: 's12Process:0:title', editBody: 's12Process:0:body' },
    { n: '02', title: 'Book & pay online', desc: 'Pick a date and time, add extras, and confirm securely.', editTitle: 's12Process:1:title', editBody: 's12Process:1:body' },
    { n: '03', title: 'Meet at the dock', desc: 'Show up with your confirmation — gear is covered, the captain handles the rest.', editTitle: 's12Process:2:title', editBody: 's12Process:2:body' }
  ];
}

function charterFaqsForTenant(tenant) {
  var raw = Array.isArray(tenant.charterFaqs) ? tenant.charterFaqs : [];
  var cleaned = raw.filter(function(f) {
    return f && (String(f.question || f.q || '').trim() || String(f.answer || f.a || '').trim());
  });
  if (cleaned.length) {
    return cleaned.slice(0, 8).map(function(f, i) {
      var a = String(f.answer || f.a || '').trim();
      if (/my trips/i.test(a)) {
        a = 'Call your captain to cancel or reschedule. Their number is on your confirmation text and on the booking confirmation page.';
      }
      return {
        q: String(f.question || f.q || '').trim() || ('Question ' + (i + 1)),
        a: a
      };
    });
  }
  return [
    { q: 'What happens if the weather is bad?', a: 'Captains will reschedule or fully refund trips cancelled for weather.' },
    { q: 'Is gear included?', a: 'Rods, bait, ice and fishing licenses are included on every listed charter unless noted.' },
    { q: 'Can I bring my own group?', a: 'Yes, most charters are private bookings for your group only.' },
    { q: 'How do I cancel or reschedule?', a: 'Call your captain to cancel or reschedule. Their number is on your confirmation text and on the booking confirmation page.' }
  ];
}

function charterFeaturedHtml(tenant, services, limit) {
  var list = (services || []).slice(0, limit || 3);
  var feats = (tenant.featuredWorkImages || tenant.galleryImages || []);
  if (!list.length) {
    return charterKeyedCardBandHtml(tenant, 'charter.featCard.empty', 'charter-blueprint charter-trip-card',
      '<p><em>Add charter trips in Manage → Charters.</em></p>');
  }
  return list.map(function(s, i) {
    var sid = s.id || s.slug || String(i);
    var img = (s.imageUrl || s.photoUrl || (feats[i] && (feats[i].url || feats[i])) || '');
    var price = charterPriceLabel(s);
    var dur = charterDurationLabel(s);
    var href = charterTripHref(tenant, s);
    var hasServiceImage = !!(s.imageUrl || s.photoUrl);
    return charterKeyedCardBandHtml(tenant, 'charter.featCard.' + sid, 'charter-blueprint charter-feat-card',
      '<div class="media">' +
        (img
          ? '<img' + (hasServiceImage ? '' : ' data-edit-key="featuredWork:' + i + '"') +
            ' src="' + esc(typeof img === 'string' ? img : '') + '" alt="">'
          : '<div data-edit-key="featuredWork:' + i + '" style="height:100%"></div>') +
      '</div>' +
      '<div class="body">' +
        '<div class="row"><span class="charter-card-title">' + svcSpan(tenant, sid, 'name', s.name || 'Charter') + '</span>' +
        (price ? '<span class="charter-price">' + svcSpan(tenant, sid, 'price', price) + '</span>' : '') + '</div>' +
        '<div class="charter-meta">' + svcSpan(tenant, sid, 'duration', dur || 'Trip') + '</div>' +
        '<p>' + svcSpan(tenant, sid, 'description', s.description || 'Private fishing charter.') + '</p>' +
        '<div style="display:flex;justify-content:flex-end"><span style="font-size:13px;font-weight:600;color:var(--charter-accent)">' +
          svcSpan(tenant, sid, 'details', 'Details →') + '</span></div>' +
      '</div>',
      ' href="' + href + '"' + svcEditAttr(sid),
      'a');
  }).join('');
}

function charterProductPriceLabel(prod) {
  if (!prod) return '';
  var sale = Number(prod.salePrice);
  var price = Number(prod.price);
  var n = (sale > 0 && sale < price) ? sale : price;
  if (!(n > 0)) return '';
  return (typeof formatMoney === 'function') ? formatMoney(n) : ('$' + n);
}

function charterProductCardHtml(tenant, prod, opts) {
  opts = opts || {};
  var pid = prod && prod.id ? String(prod.id) : '';
  var img = prod && prod.imageUrl ? String(prod.imageUrl) : '';
  var cat = prod && prod.category ? String(prod.category).trim() : '';
  var name = (prod && prod.name) ? prod.name : 'Product';
  var price = charterProductPriceLabel(prod);
  var catAttr = cat ? ' data-charter-cat="' + esc(cat.toLowerCase()) + '"' : '';
  var add = opts.addToCart && pid
    ? '<button type="button" class="charter-product-add" data-cta-key="wc.charter.addToCart" data-charter-add-cart="' + esc(pid) + '">' +
      wcSpan(tenant, 'wc.charter.addToCart', 'Add to cart') + '</button>'
    : '';
  var href = opts.shopHref || '';
  var surfaceKey = opts.surfaceKey || '';
  var copyBase = pid ? ('wc.charter.product.' + pid) : '';
  var inner =
    '<div class="media">' +
      (img ? '<img src="' + esc(img) + '" alt="">' : '<div class="charter-product-ph"></div>') +
    '</div>' +
    '<div class="body">' +
      (cat ? '<div class="charter-product-cat">' +
        (copyBase ? wcSpan(tenant, copyBase + '.category', cat) : esc(cat)) + '</div>' : '') +
      '<div class="charter-card-title">' +
        (copyBase ? wcSpan(tenant, copyBase + '.name', name) : esc(name)) + '</div>' +
      '<div class="charter-product-foot">' +
        add +
        (price ? '<span class="charter-price">' +
          (copyBase ? wcSpan(tenant, copyBase + '.price', price) : esc(price)) + '</span>' : '') +
      '</div>' +
    '</div>';
  if (!surfaceKey) {
    var plainTag = (opts.addToCart || !href) ? 'article' : 'a';
    var plainHref = href ? ' href="' + esc(href) + '"' : '';
    return '<' + plainTag + ' class="charter-blueprint charter-product-card"' + plainHref + catAttr + '>' +
      inner + '</' + plainTag + '>';
  }
  var cardTag = (opts.addToCart || !href) ? 'article' : 'a';
  var cardExtra = catAttr + (href ? ' href="' + esc(href) + '"' : '');
  return charterKeyedCardBandHtml(tenant, surfaceKey, 'charter-blueprint charter-product-card', inner, cardExtra, cardTag);
}

function charterHomeShopSectionHtml(tenant) {
  if (!tenantShowShopPage(tenant)) return '';
  var base = tenantBaseUrl(tenant);
  var list = (tenant._products || []).slice(0, 4);
  var cards = list.length
    ? list.map(function(p) {
        var pid = p && p.id ? String(p.id) : 'empty';
        return charterProductCardHtml(tenant, p, { shopHref: base + '/shop', surfaceKey: 'charter.homeProduct.' + pid });
      }).join('')
    : charterKeyedCardBandHtml(tenant, 'charter.homeProduct.empty', 'charter-blueprint charter-trip-card',
      '<p><em>' + wcSpan(tenant, 'wc.charter.shopEmpty', 'Add products in Shop to show them here.') + '</em></p>');
  return '<section class="charter-section" id="shop"' + charterBandAttrs(tenant, 'card', 'charter.shop') + '>' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:28px">' +
      '<h2 class="charter-sec-heading" style="margin:0">' + wcSpan(tenant, 'wc.charter.shopHeading', 'Shop') + '</h2>' +
      '<a href="' + base + '/shop" style="font-weight:600;font-size:14px;color:var(--charter-accent)">' +
        wcSpan(tenant, 'wc.charter.shopViewAll', 'View all →') + '</a>' +
    '</div>' +
    '<div class="charter-shop-home-grid">' + cards + '</div>' +
  '</section>';
}

function charterShopPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var list = tenant._products || [];
  var cats = [];
  var seen = {};
  list.forEach(function(p) {
    var c = (p.category || '').toString().trim();
    if (!c) return;
    var k = c.toLowerCase();
    if (seen[k]) return;
    seen[k] = true;
    cats.push(c);
  });
  var countLabel = list.length === 1 ? '1 product' : (list.length + ' products');
  var filterHtml = cats.map(function(c) {
    return '<label class="charter-filter-row">' +
      '<input type="checkbox" data-charter-shop-cat="' + esc(c.toLowerCase()) + '">' +
      '<span class="charter-filter-text">' + esc(c) + '</span></label>';
  }).join('');
  var cards = list.length
    ? list.map(function(p) {
        var pid = p && p.id ? String(p.id) : 'empty';
        return charterProductCardHtml(tenant, p, { addToCart: true, surfaceKey: 'charter.shopProduct.' + pid });
      }).join('')
    : '<p class="charter-browse-empty">No products yet. Add them in Shop.</p>';
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'shop') +
    charterRouteCanvasOpen(tenant, 'charter.shopPage') +
    '<div class="charter-section charter-browse-head">' +
      '<div class="charter-sec-label charter-sec-label--ink">' +
        wcSpan(tenant, 'wc.charter.shopCountLabel', countLabel.toUpperCase()) + '</div>' +
      '<h2 class="charter-sec-heading">' + wcSpan(tenant, 'wc.charter.shopPageHeading', 'Shop') + '</h2>' +
      '<p class="charter-shop-lead">' +
        wcSpan(tenant, 'wc.charter.shopLead', 'Apparel, drinkware and tackle from the boat.') +
      '</p>' +
    '</div>' +
    '<div class="charter-shop-layout">' +
      '<aside class="charter-filters">' +
        (cats.length
          ? ('<div class="charter-filter-block">' +
              '<h4>Category</h4>' +
              '<div class="charter-filter-list">' + filterHtml + '</div>' +
              '<button type="button" class="charter-clear-filters" data-charter-shop-clear>Clear filters</button>' +
            '</div>')
          : '') +
      '</aside>' +
      '<div class="charter-shop-grid" id="charter-shop-grid">' + cards + '</div>' +
    '</div>' +
    '</div>' +
    charterFooterHtml(tenant) +
  '</div>';
}

function bindCharterShop(tenant) {
  var grid = document.getElementById('charter-shop-grid');
  var checks = document.querySelectorAll('[data-charter-shop-cat]');
  var clearBtn = document.querySelector('[data-charter-shop-clear]');
  function applyCatFilter() {
    if (!grid) return;
    var selected = [];
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].checked) selected.push(String(checks[i].getAttribute('data-charter-shop-cat') || ''));
    }
    var cards = grid.querySelectorAll('.charter-product-card');
    for (var c = 0; c < cards.length; c++) {
      var cat = String(cards[c].getAttribute('data-charter-cat') || '');
      var show = !selected.length || selected.indexOf(cat) !== -1;
      cards[c].style.display = show ? '' : 'none';
    }
  }
  for (var j = 0; j < checks.length; j++) {
    checks[j].addEventListener('change', applyCatFilter);
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      for (var k = 0; k < checks.length; k++) checks[k].checked = false;
      applyCatFilter();
    });
  }
  document.querySelectorAll('[data-charter-add-cart]').forEach(function(btn) {
    btn.addEventListener('click', function(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var pid = btn.getAttribute('data-charter-add-cart');
      var prod = findProductById(tenant, pid);
      if (!prod) return;
      addLineToShopCart(tenant.id, prod, 1);
      renderShopCartDrawer(tenant.id);
      updateShopCartNavCount(tenant.id);
      var drawer = document.getElementById('bk-shop-cart-drawer');
      if (drawer) drawer.classList.add('is-open');
    });
  });
}

function charterHomePage(tenant, services) {
  var base = tenantBaseUrl(tenant);
  var area = (tenant.serviceArea || '').toString().trim() || 'Key West & the Florida Keys';
  var heroTitleRaw = tenantSiteTextOrCompute(tenant, 'heroTagline', function() {
    return 'Book a fishing charter in minutes';
  });
  var heroLeadRaw = tenantSiteTextOrCompute(tenant, 'heroSubtitle', function() {
    return 'Licensed captains, our own boats, transparent pricing. Half-day to full-day trips out of Key West.';
  });
  var heroImg = resolvedHeroImageUrl(tenant);
  var quoteFallback = (tenant.reviews && tenant.reviews[0] && (tenant.reviews[0].text || tenant.reviews[0].quote))
    ? (tenant.reviews[0].text || tenant.reviews[0].quote)
    : "Capt. Mike put us on yellowtail before the first cold drink was gone. Best half-day we’ve done in the Keys.";
  var quoteByFallback = (tenant.reviews && tenant.reviews[0] && tenant.reviews[0].name)
    ? tenant.reviews[0].name
    : 'Danielle R. · Half-Day Reef Charter';
  var quoteImg = (tenant.galleryImages && tenant.galleryImages[0] && (tenant.galleryImages[0].url || tenant.galleryImages[0])) || '';
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'home') +
    charterHeroSectionHtml(tenant,
      '<div class="charter-hero-media"' + (heroImg
        ? ' style="background-image:url(' + esc(heroImg) + ');background-size:cover;background-position:center"'
        : '') + '>' +
        (heroImg
          ? '<img data-edit-key="heroImage" src="' + esc(heroImg) + '" alt="">'
          : '<div data-edit-key="heroImage" class="charter-hero-slot"></div>') +
        '<button type="button" class="bk-hero-image-hit" data-edit-key="heroImage" aria-label="Change hero image"></button>' +
      '</div>' +
      '<div class="charter-hero-scrim"></div>' +
      '<div class="charter-hero-inner">' +
        '<div class="charter-sec-label charter-sec-label--light">' +
          wcSpan(tenant, 'wc.charter.heroEyebrow', area) + '</div>' +
        '<h1 class="charter-hero-title">' + siteTextSpan('heroTagline', heroTitleRaw) + '</h1>' +
        '<p class="charter-hero-lead">' + siteTextSpan('heroSubtitle', heroLeadRaw) + '</p>' +
        (tenantShowChartersPage(tenant) && tenantShowBookPage(tenant) ? charterHeroSearchBandHtml(tenant,
          '<label class="field">' +
            '<span class="charter-search-field-label">' + wcSpan(tenant, 'wc.charter.searchDay', 'Day') + '</span>' +
            '<input type="date" id="charter-home-date" class="charter-search-date" data-charter-home-date>' +
          '</label>' +
          '<label class="field">' +
            '<span class="charter-search-field-label">' + wcSpan(tenant, 'wc.charter.searchTime', 'Time') + '</span>' +
            '<select class="charter-search-date" data-charter-home-time></select>' +
          '</label>' +
          '<label class="field">' +
            '<span class="charter-search-field-label">' + wcSpan(tenant, 'wc.charter.searchPeople', 'People') + '</span>' +
            '<select class="charter-search-date" data-charter-home-people>' +
              charterPeopleOptionsHtml(tenant, 0, true) +
            '</select>' +
          '</label>' +
          '<label class="field">' +
            '<span class="charter-search-field-label">' + wcSpan(tenant, 'wc.charter.searchDuration', 'Duration') + '</span>' +
            '<select class="charter-search-date" data-charter-home-duration>' +
              '<option value="">Any</option>' +
              '<option value="120">2 hrs</option>' +
              '<option value="240">4 hrs</option>' +
              '<option value="360">6 hrs</option>' +
              '<option value="480">Full day (8 hrs)</option>' +
            '</select>' +
          '</label>' +
          (charterHasFleet(tenant) ?
          '<label class="field charter-search-field--full">' +
            '<span class="charter-search-field-label">' + wcSpan(tenant, 'wc.charter.searchBoat', 'Boat') + '</span>' +
            '<select class="charter-search-date" data-charter-home-boat>' +
              '<option value="">Any boat</option>' +
              ((tenant.charterBoats || []).map(function(b) {
                return '<option value="' + esc(b.id || '') + '">' + esc(charterBoatLabel(b)) + '</option>';
              }).join('')) +
            '</select>' +
          '</label>' : '') +
          '<a class="charter-btn charter-btn-block charter-search-go" data-cta-key="wc.charter.heroSearch" data-charter-home-search href="' + base + '/charters">' +
            wcSpan(tenant, 'wc.charter.heroSearch', 'Search') + '</a>'
        ) : '') +
      '</div>') +
    (tenantShowChartersPage(tenant) ? '<section class="charter-section"' + charterBandAttrs(tenant, 'featured', 'charter.featured') + '>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:28px">' +
        '<div>' + wcLabelBlock(tenant, 'wc.charter.featuredLabel', 'Featured', 'charter-sec-label charter-sec-label--ink') +
        '<h2 class="charter-sec-heading" style="margin:0">' +
          wcSpan(tenant, 'wc.charter.featuredHeading', 'Our charters') + '</h2></div>' +
        '<a href="' + base + '/charters"' +
          ' style="font-weight:600;font-size:14px;color:var(--charter-accent)">' +
          wcSpan(tenant, 'wc.charter.viewAll', 'View all →') + '</a>' +
      '</div>' +
      '<div class="charter-feat-grid">' + charterFeaturedHtml(tenant, services, 3) + '</div>' +
    '</section>' : '') +
    charterHomeShopSectionHtml(tenant) +
    '<section class="charter-section"' + charterBandAttrs(tenant, 'card', 'charter.quote') + '>' +
      charterKeyedCardBandHtml(tenant, 'charter.quoteCard', 'charter-blueprint charter-quote',
        '<div class="charter-quote-copy">' +
          '<p>' + wcSpan(tenant, 'wc.charter.quote', quoteFallback) + '</p>' +
          '<div style="font-size:13px;opacity:.65">' + wcSpan(tenant, 'wc.charter.quoteBy', quoteByFallback) + '</div>' +
        '</div>' +
        '<div class="charter-quote-media">' +
          (quoteImg
            ? '<img data-edit-key="galleryImage:0" src="' + esc(typeof quoteImg === 'string' ? quoteImg : '') + '" alt="">'
            : '<div data-edit-key="galleryImage:0" class="charter-quote-ph" aria-label="Add quote photo"></div>') +
        '</div>',
        ' data-edit-key="charterQuote:edit" role="button" aria-label="Edit client quote"') +
    '</section>' +
    charterFooterHtml(tenant) +
    '</div>';
}

function bindCharterScrollReveal(root) {
  var scope = root || document;
  var page = scope.querySelector ? scope.querySelector('.charter-page') : null;
  if (!page || page.dataset.charterRevealBound === '1') return;
  page.dataset.charterRevealBound = '1';

  var selector = [
    '.charter-section',
    '.charter-trip-card',
    '.charter-feat-card',
    '.charter-shop-home-grid > *',
    '.charter-shop-grid > *',
    '.charter-browse-row',
    '.charter-detail-lead',
    '.charter-detail-gallery',
    '.charter-detail-body > *',
    '.charter-about-heading',
    '.charter-about-story',
    '.charter-about-media',
    '.charter-steps > *'
  ].join(',');
  var targets = Array.prototype.slice.call(page.querySelectorAll(selector));
  if (!targets.length) return;

  var staggerGroups = page.querySelectorAll(
    '.charter-trip-grid,.charter-feat-grid,.charter-shop-home-grid,' +
    '.charter-shop-grid,.charter-browse-list,.charter-steps'
  );
  for (var g = 0; g < staggerGroups.length; g++) {
    var children = staggerGroups[g].children;
    for (var c = 0; c < children.length; c++) {
      children[c].style.setProperty('--charter-reveal-delay', Math.min(c, 4) * 65 + 'ms');
    }
  }
  for (var i = 0; i < targets.length; i++) targets[i].classList.add('charter-reveal');

  if (!window.IntersectionObserver ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    for (var j = 0; j < targets.length; j++) targets[j].classList.add('charter-reveal--visible');
    return;
  }
  if (window.__charterRevealObserver) window.__charterRevealObserver.disconnect();
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('charter-reveal--visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
  window.__charterRevealObserver = observer;
  for (var k = 0; k < targets.length; k++) observer.observe(targets[k]);
}

function bindCharterHomeSearch(tenant, services) {
  var dateEl = document.querySelector('[data-charter-home-date]');
  var timeEl = document.querySelector('[data-charter-home-time]');
  var peopleEl = document.querySelector('[data-charter-home-people]');
  var durEl = document.querySelector('[data-charter-home-duration]');
  var boatEl = document.querySelector('[data-charter-home-boat]');
  var btn = document.querySelector('[data-charter-home-search]');
  if (!dateEl || !btn) return;
  function openCharterSearchControl(control) {
    if (!control) return;
    control.focus();
    if (typeof control.showPicker === 'function') {
      try { control.showPicker(); return; } catch (ePicker) {}
    }
    try { control.click(); } catch (eClick) {}
  }
  var searchFields = document.querySelectorAll('.charter-search label.field');
  for (var sf = 0; sf < searchFields.length; sf++) {
    (function(field) {
      field.addEventListener('click', function(ev) {
        var control = field.querySelector('input, select');
        if (!control || ev.target === control) return;
        ev.preventDefault();
        openCharterSearchControl(control);
      });
    })(searchFields[sf]);
  }
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var max = new Date(today);
  max.setMonth(max.getMonth() + 6);
  function iso(d) {
    if (typeof calendarIsoDate === 'function') return calendarIsoDate(d);
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  dateEl.min = iso(today);
  dateEl.max = iso(max);
  if (!dateEl.value) dateEl.value = iso(today);
  function fillHomeTimes() {
    if (!timeEl) return;
    var prev = String(timeEl.value || '');
    var picked = charterDateFromIso(String(dateEl.value || '').trim());
    timeEl.innerHTML = '';
    timeEl.appendChild(new Option('Any time', ''));
    if (!tenant._charterOccupancyReady) {
      timeEl.appendChild(new Option('Loading availability…', '', true, false));
      timeEl.options[timeEl.options.length - 1].disabled = true;
      return;
    }
    if (tenant._charterOccupancyFailed) {
      timeEl.appendChild(new Option('Availability unavailable', '', true, false));
      timeEl.options[timeEl.options.length - 1].disabled = true;
      return;
    }
    if (!charterHasFleet(tenant)) {
      timeEl.appendChild(new Option('Not available yet', '', true, false));
      timeEl.options[timeEl.options.length - 1].disabled = true;
      return;
    }
    var wantedDur = durEl ? parseInt(durEl.value || '0', 10) : 0;
    var people = peopleEl ? parseInt(peopleEl.value || '0', 10) : 0;
    var boat = boatEl ? String(boatEl.value || '').trim() : '';
    var seen = {};
    var clocks = [];
    var tripList = services || [];
    for (var si = 0; picked && si < tripList.length; si++) {
      var svc = tripList[si];
      var svcDur = Number(svc.durationMinutes) || 240;
      if (wantedDur > 0 && Math.abs(svcDur - wantedDur) > 45) continue;
      var starts = charterOpenStartsForTrip(tenant, picked, svcDur, {
        occupancy: tenant._charterOccupancy || [],
        people: people,
        maxPeople: charterMaxPeopleForTrip(tenant, svc),
        service: svc,
        boatFilterId: boat
      });
      for (var st = 0; st < starts.length; st++) {
        if (!seen[starts[st]]) {
          seen[starts[st]] = true;
          clocks.push(starts[st]);
        }
      }
    }
    clocks.sort(function(a, b) { return a - b; });
    for (var ci = 0; ci < clocks.length; ci++) {
      var m = clocks[ci];
      var hh = String(Math.floor(m / 60)).padStart(2, '0');
      var mm = String(m % 60).padStart(2, '0');
      var val = hh + ':' + mm;
      timeEl.appendChild(new Option(charterFormatMin(m), val));
    }
    if (prev) {
      for (var i = 0; i < timeEl.options.length; i++) {
        if (timeEl.options[i].value === prev) { timeEl.value = prev; break; }
      }
    }
  }
  fillHomeTimes();
  function syncHref() {
    btn.setAttribute('href', charterSearchHref(tenant, {
      date: String(dateEl.value || '').trim(),
      time: timeEl ? String(timeEl.value || '').trim() : '',
      people: peopleEl ? parseInt(peopleEl.value || '0', 10) : 0,
      duration: durEl ? parseInt(durEl.value || '0', 10) : 0,
      boat: boatEl ? String(boatEl.value || '').trim() : ''
    }));
  }
  [dateEl, timeEl, peopleEl, durEl, boatEl].forEach(function(el) {
    if (!el) return;
    el.addEventListener('change', function() {
      if (el === dateEl || el === durEl || el === peopleEl || el === boatEl) fillHomeTimes();
      syncHref();
    });
    el.addEventListener('input', syncHref);
  });
  syncHref();
  btn.addEventListener('click', function(ev) {
    syncHref();
    var href = btn.getAttribute('href');
    if (!href) return;
    ev.preventDefault();
    window.location.assign(href);
  });
  charterBindOccupancyLifecycle(tenant, function() {
    fillHomeTimes();
    syncHref();
  });
  charterLoadOccupancy(tenant, { force: true }).then(function() {
    fillHomeTimes();
    syncHref();
  }).catch(function() {
    fillHomeTimes();
    syncHref();
  });
}

function charterBrowseChipHtml(tenant, kind, copyKey, fallback) {
  return '<button type="button" class="charter-filter-chip" data-charter-chip="' + kind + '">' +
    '<span class="charter-filter-chip-label" data-charter-chip-label>' +
    wcSpan(tenant, copyKey, fallback) + '</span>' +
    '<span class="charter-filter-chip-chevron" aria-hidden="true">▾</span></button>';
}

function charterBrowseDropdownsHtml(tenant, typeOpts, peopleOpts, boatOpts, withClear) {
  var html =
    '<label class="charter-drop">' +
      '<span>' + wcSpan(tenant, 'wc.charter.browseTripType', 'Trip type') + '</span>' +
      '<select data-charter-trip-filter>' + typeOpts + '</select>' +
    '</label>' +
    '<label class="charter-drop">' +
      '<span>' + wcSpan(tenant, 'wc.charter.browseDuration', 'Duration') + '</span>' +
      '<select data-charter-dur-filter>' +
        '<option value="">Any duration</option>' +
        '<option value="2">2 hrs</option>' +
        '<option value="3">3 hrs</option>' +
        '<option value="4">4 hrs</option>' +
        '<option value="5">5 hrs</option>' +
        '<option value="6plus">6 hrs+</option>' +
      '</select>' +
    '</label>' +
    '<label class="charter-drop">' +
      '<span>' + wcSpan(tenant, 'wc.charter.browsePeople', 'People') + '</span>' +
      '<select data-charter-people-filter>' + peopleOpts + '</select>' +
    '</label>' +
    (charterHasFleet(tenant) ?
    '<label class="charter-drop">' +
      '<span>' + wcSpan(tenant, 'wc.charter.browseBoatHeading', 'Boat') + '</span>' +
      '<select data-charter-boat-filter>' + boatOpts + '</select>' +
    '</label>' : '');
  if (withClear) {
    html += '<button type="button" class="charter-clear-filters" data-charter-browse-clear>' +
      wcSpan(tenant, 'wc.charter.browseClearFilters', 'Clear') + '</button>';
  }
  return html;
}

function charterBrowsePage(tenant, services) {
  var list = services || [];
  var feats = (tenant.featuredWorkImages || tenant.galleryImages || []);
  var rows = list.map(function(s, i) {
    var sid = s.id || s.slug || String(i);
    var img = (s.imageUrl || s.photoUrl || (feats[i] && (feats[i].url || feats[i])) || '');
    var hasServiceImage = !!(s.imageUrl || s.photoUrl);
    var price = charterPriceLabel(s);
    var dur = charterDurationLabel(s);
    var tripKey = String(s.name || '').trim().toLowerCase();
    var mins = Number(s.durationMinutes) || 0;
    return '<article class="charter-blueprint charter-browse-row"' +
      svcEditAttr(sid) +
      ' data-charter-row="1"' +
      ' data-charter-trip="' + esc(tripKey) + '"' +
      ' data-charter-mins="' + mins + '"' +
      ' data-charter-slug="' + esc(s.slug || '') + '"' +
      ' data-charter-boats="' + esc(charterServiceBoatIds(s).join(',')) + '" hidden>' +
      '<a class="media" data-charter-trip-link href="' + charterTripHref(tenant, s) + '">' +
        (img
          ? '<img' + (hasServiceImage ? '' : ' data-edit-key="featuredWork:' + i + '"') +
            ' src="' + esc(typeof img === 'string' ? img : '') + '" alt="">'
          : '<div data-edit-key="featuredWork:' + i + '" class="charter-browse-ph"></div>') +
      '</a>' +
      '<div class="body">' +
        '<div class="charter-browse-row-top">' +
          '<a class="charter-card-title" data-charter-trip-link href="' + charterTripHref(tenant, s) + '">' +
            svcSpan(tenant, sid, 'name', s.name || 'Charter') + '</a>' +
          (price
            ? '<a class="charter-price" data-charter-trip-link href="' + charterTripHref(tenant, s) + '">' +
                svcSpan(tenant, sid, 'price', price + ' per trip') + '</a>'
            : '') +
        '</div>' +
        '<div class="charter-browse-submeta" data-charter-submeta></div>' +
        '<div class="charter-browse-times-row">' +
          '<div class="charter-browse-times" data-charter-times></div>' +
          '<button type="button" class="charter-browse-times-more" data-charter-times-more hidden></button>' +
        '</div>' +
        '<a class="charter-btn charter-browse-book" data-charter-trip-link href="' + charterTripHref(tenant, s) + '">' +
          wcSpan(tenant, 'wc.charter.browseBookTrip', 'Book this trip') + '</a>' +
      '</div></article>';
  }).join('') || '';
  var typeSeen = {};
  var types = [];
  list.forEach(function(s) {
    var n = String(s.name || '').trim();
    if (!n) return;
    var k = n.toLowerCase();
    if (typeSeen[k]) return;
    typeSeen[k] = true;
    types.push(n);
  });
  var typeOpts = '<option value="">All trip types</option>' + types.map(function(label) {
    return '<option value="' + esc(label.toLowerCase()) + '">' + esc(label) + '</option>';
  }).join('');
  var boats = Array.isArray(tenant.charterBoats) ? tenant.charterBoats : [];
  var boatOpts = '<option value="">Any boat</option>' + boats.map(function(b) {
    return '<option value="' + esc(b.id || '') + '">' + esc(charterBoatLabel(b)) + '</option>';
  }).join('');
  var maxGuests = charterFilterPeopleMax(tenant);
  var peopleOpts = '<option value="">Any party</option>';
  for (var gp = 1; gp <= maxGuests; gp++) {
    peopleOpts += '<option value="' + gp + '">' + gp + (gp === 1 ? ' person' : ' people') + '</option>';
  }
  var emptyHtml = !charterHasFleet(tenant)
    ? '<p class="charter-browse-empty" data-charter-browse-empty>' +
        wcSpan(tenant, 'wc.charter.browseNoFleet', charterNoFleetMessage()) + '</p>'
    : (list.length
      ? '<p class="charter-browse-empty" data-charter-browse-empty>' +
          wcSpan(tenant, 'wc.charter.browsePickOpenDay', 'Pick an open day to see charters.') + '</p>'
      : '<p class="charter-browse-empty">' +
          wcSpan(tenant, 'wc.charter.browseNoCharters', 'No charters listed yet. Add trips in Manage → Charters.') + '</p>');
  var browseInner =
    '<div class="charter-browse-layout">' +
      '<div class="charter-browse-filters charter-browse-filters--mobile">' +
        '<div class="charter-browse-date-section">' +
          '<div class="charter-browse-date-head">' +
            '<span class="charter-browse-date-title" data-charter-cal-title></span>' +
            '<button type="button" class="charter-browse-month-btn" data-charter-month-open aria-label="Choose month">' +
              wcSpan(tenant, 'wc.charter.browseMonth', 'Month') +
            '</button>' +
          '</div>' +
          '<div class="charter-browse-date-strip" data-charter-date-strip></div>' +
        '</div>' +
        '<div class="charter-browse-filter-chips" data-charter-filter-chips>' +
          charterBrowseChipHtml(tenant, 'type', 'wc.charter.browseChipType', 'All trip types') +
          charterBrowseChipHtml(tenant, 'duration', 'wc.charter.browseChipDuration', 'Any duration') +
          (charterHasFleet(tenant) ?
          charterBrowseChipHtml(tenant, 'boat', 'wc.charter.browseChipBoat', 'Any boat') : '') +
          charterBrowseChipHtml(tenant, 'people', 'wc.charter.browseChipPeople', 'Any party size') +
        '</div>' +
      '</div>' +
      '<aside class="charter-browse-sidebar">' +
        '<section class="charter-browse-sidebar-cal" aria-label="Choose a day">' +
          '<div class="charter-browse-cal-card charter-browse-cal-card--desktop">' +
            '<div class="charter-cal-head">' +
              '<button type="button" class="charter-cal-nav" data-charter-cal-prev aria-label="Previous month">‹</button>' +
              '<span data-charter-cal-title></span>' +
              '<button type="button" class="charter-cal-nav" data-charter-cal-next aria-label="Next month">›</button>' +
            '</div>' +
            '<div class="charter-cal" data-charter-cal-grid></div>' +
            '<div class="charter-cal-legend">' +
              '<span><i class="open"></i>' + wcSpan(tenant, 'wc.charter.browseOpen', 'Open') + '</span>' +
              '<span><i class="closed"></i>' + wcSpan(tenant, 'wc.charter.browseClosed', 'Closed') + '</span>' +
            '</div>' +
          '</div>' +
        '</section>' +
        '<section class="charter-browse-sidebar-filters" aria-label="Filters">' +
          '<div class="charter-browse-dropdowns">' +
            charterBrowseDropdownsHtml(tenant, typeOpts, peopleOpts, boatOpts, true) +
          '</div>' +
        '</section>' +
      '</aside>' +
      '<div class="charter-browse-main">' +
        '<div class="charter-browse-count-row">' +
          '<div class="charter-sec-label charter-sec-label--ink" data-charter-browse-count>' +
            wcSpan(tenant, 'wc.charter.browsePickDayLabel', 'PICK A DAY') + '</div>' +
        '</div>' +
        '<div class="charter-browse-list" data-charter-browse-list>' + rows + emptyHtml + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="charter-filter-sheet" data-charter-filter-sheet hidden aria-hidden="true">' +
      '<button type="button" class="charter-filter-sheet-backdrop" data-charter-filter-close aria-label="Close filters"></button>' +
      '<div class="charter-filter-sheet-panel" role="dialog" aria-modal="true" aria-label="Filters">' +
        '<div class="charter-browse-dropdowns">' +
          charterBrowseDropdownsHtml(tenant, typeOpts, peopleOpts, boatOpts, true) +
        '</div>' +
      '</div>' +
    '</div>';
  var monthSheetHtml =
    '<div class="charter-month-sheet" data-charter-month-sheet hidden aria-hidden="true">' +
      '<button type="button" class="charter-month-sheet-backdrop" data-charter-month-close aria-label="Close month picker"></button>' +
      '<div class="charter-month-sheet-panel" role="dialog" aria-modal="true" aria-label="Choose a day">' +
        '<div class="charter-sheet-grab" aria-hidden="true"></div>' +
        '<div class="charter-browse-cal-card charter-browse-cal-card--sheet">' +
          '<div class="charter-cal-head">' +
            '<button type="button" class="charter-cal-nav" data-charter-cal-prev-sheet aria-label="Previous month">‹</button>' +
            '<span data-charter-cal-title-sheet></span>' +
            '<button type="button" class="charter-cal-nav" data-charter-cal-next-sheet aria-label="Next month">›</button>' +
          '</div>' +
          '<div class="charter-cal" data-charter-cal-grid-sheet></div>' +
          '<div class="charter-cal-legend">' +
            '<span><i class="open"></i>' + wcSpan(tenant, 'wc.charter.browseOpen', 'Open') + '</span>' +
            '<span><i class="closed"></i>' + wcSpan(tenant, 'wc.charter.browseClosed', 'Closed') + '</span>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="charter-btn charter-btn-block charter-month-sheet-apply" data-charter-month-apply>' +
          wcSpan(tenant, 'wc.charter.browseShowCharters', 'Show charters') + '</button>' +
      '</div>' +
    '</div>';
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'charters') +
    charterRouteCanvasHtml(tenant, 'charter.chartersPage', browseInner, 'card') +
    monthSheetHtml +
    charterFooterHtml(tenant) +
    '</div>';
}

function bindCharterBrowse(tenant, services) {
  var grid = document.querySelector('[data-charter-cal-grid]');
  var gridSheet = document.querySelector('[data-charter-cal-grid-sheet]');
  var titleSheetEl = document.querySelector('[data-charter-cal-title-sheet]');
  var prevBtn = document.querySelector('[data-charter-cal-prev]');
  var nextBtn = document.querySelector('[data-charter-cal-next]');
  var prevSheetBtn = document.querySelector('[data-charter-cal-prev-sheet]');
  var nextSheetBtn = document.querySelector('[data-charter-cal-next-sheet]');
  var monthSheet = document.querySelector('[data-charter-month-sheet]');
  var monthCloseBtn = document.querySelector('[data-charter-month-close]');
  var monthApplyBtn = document.querySelector('[data-charter-month-apply]');
  var listEl = document.querySelector('[data-charter-browse-list]');
  var emptyEl = document.querySelector('[data-charter-browse-empty]');
  var countEl = document.querySelector('[data-charter-browse-count]');
  var clearBtns = document.querySelectorAll('[data-charter-browse-clear]');
  var dateStripEl = document.querySelector('[data-charter-date-strip]');
  var monthOpenBtn = document.querySelector('[data-charter-month-open]');
  var filterChips = document.querySelector('[data-charter-filter-chips]');
  var filterSheet = document.querySelector('[data-charter-filter-sheet]');
  var filterCloseBtn = document.querySelector('[data-charter-filter-close]');
  if (!listEl) return;

  function browseFilterEls(kind) {
    return document.querySelectorAll('[data-charter-' + kind + '-filter]');
  }
  function browseFilterEl(kind) {
    var list = browseFilterEls(kind);
    return list.length ? list[0] : null;
  }
  function browseSyncFilters(kind, value, skip) {
    browseFilterEls(kind).forEach(function(el) {
      if (el !== skip) el.value = value;
    });
  }

  var now = new Date();
  var viewYear = now.getFullYear();
  var viewMonth = now.getMonth();
  var minKey = viewYear * 12 + viewMonth;
  var maxKey = minKey + 6;
  var search = charterSearchQuery();
  var selectedIso = search.date;
  var browseNeedsDefaultDate = !search.date;
  var list = services || [];
  var startMin = charterParseTimeToMin(search.time);
  if (search.duration > 0) {
    browseSyncFilters('dur', charterDurationBucket(search.duration));
  }
  if (search.boat) browseSyncFilters('boat', search.boat);
  if (search.people > 0) browseSyncFilters('people', String(search.people));
  syncBrowseFilterSelects();

  function charterBrowseBoatName(s, boatFilterId) {
    if (boatFilterId) {
      var picked = charterBoatById(tenant, boatFilterId);
      if (picked) return charterBoatLabel(picked);
    }
    var ids = charterServiceBoatIds(s);
    for (var bi = 0; bi < ids.length; bi++) {
      var boat = charterBoatById(tenant, ids[bi]);
      if (boat) return charterBoatLabel(boat);
    }
    return '';
  }

  function charterBrowseSubmetaText(s, boatFilterId) {
    if (!s) return '';
    var dur = charterDurationLabel(s) || 'Trip';
    var boat = charterBrowseBoatName(s, boatFilterId);
    var spots = maxPeopleForFilteredTrip(s);
    var parts = [dur];
    if (boat) parts.push(boat);
    if (spots > 0) parts.push(spots + (spots === 1 ? ' spot' : ' spots'));
    return parts.join(' • ');
  }

  function selectLabel(sel, fallback) {
    if (!sel) return fallback;
    var opt = sel.options[sel.selectedIndex];
    return (opt && opt.textContent) ? String(opt.textContent).trim() : fallback;
  }

  function setFilterSheetOpen(open) {
    if (!filterSheet) return;
    if (open) {
      filterSheet.removeAttribute('hidden');
      filterSheet.setAttribute('aria-hidden', 'false');
      document.body.classList.add('charter-filter-sheet-open');
    } else {
      filterSheet.setAttribute('hidden', 'hidden');
      filterSheet.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('charter-filter-sheet-open');
    }
  }

  function paintFilterChips() {
    var typeChip = filterChips ? filterChips.querySelector('[data-charter-chip="type"]') : null;
    var durChip = filterChips ? filterChips.querySelector('[data-charter-chip="duration"]') : null;
    var peopleChip = filterChips ? filterChips.querySelector('[data-charter-chip="people"]') : null;
    var boatChip = filterChips ? filterChips.querySelector('[data-charter-chip="boat"]') : null;
    if (!filterChips) return;
    function setChipLabel(chip, text) {
      if (!chip) return;
      var label = chip.querySelector('[data-charter-chip-label]');
      if (label) label.textContent = text;
      else chip.textContent = text;
    }
    if (typeChip) {
      setChipLabel(typeChip, selectLabel(browseFilterEl('trip'), webCopyOverrideText(tenant, 'wc.charter.browseChipType', 'All trip types')));
      typeChip.classList.toggle('is-active', !!(browseFilterEl('trip') && browseFilterEl('trip').value));
    }
    if (durChip) {
      setChipLabel(durChip, selectLabel(browseFilterEl('dur'), webCopyOverrideText(tenant, 'wc.charter.browseChipDuration', 'Any duration')));
      durChip.classList.toggle('is-active', !!(browseFilterEl('dur') && browseFilterEl('dur').value));
    }
    if (peopleChip) {
      setChipLabel(peopleChip, selectLabel(browseFilterEl('people'), webCopyOverrideText(tenant, 'wc.charter.browseChipPeople', 'Any party size')));
      peopleChip.classList.toggle('is-active', !!(browseFilterEl('people') && browseFilterEl('people').value));
    }
    if (boatChip) {
      setChipLabel(boatChip, selectLabel(browseFilterEl('boat'), webCopyOverrideText(tenant, 'wc.charter.browseChipBoat', 'Any boat')));
      boatChip.classList.toggle('is-active', !!(browseFilterEl('boat') && browseFilterEl('boat').value));
    }
  }

  function buildDateStripHtml() {
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var html = '';
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var startDay = (viewYear === today.getFullYear() && viewMonth === today.getMonth())
      ? today.getDate()
      : 1;
    for (var d = startDay; d <= daysInMonth; d++) {
      var date = new Date(viewYear, viewMonth, d);
      var iso = calendarIsoDate(date);
      var open = dayHasMatchingTrip(date);
      var isPast = date < today;
      var cls = 'charter-date-strip-day';
      if (iso === selectedIso) cls += ' is-selected';
      if (!open || isPast) cls += ' is-closed';
      var wd = date.toLocaleDateString('en-US', { weekday: 'short' }).replace(/\./g, '').toUpperCase();
      html += '<button type="button" class="' + cls + '" data-charter-strip-day="' + iso + '"' +
        (open && !isPast ? '' : ' disabled') + '>' +
        '<span class="wd">' + wd + '</span>' +
        '<span class="num">' + d + '</span></button>';
    }
    return html;
  }

  function scrollDateStripToSelected(smooth) {
    if (!dateStripEl) return;
    var sel = dateStripEl.querySelector('.is-selected');
    if (!sel) {
      dateStripEl.scrollLeft = 0;
      return;
    }
    var target = Math.max(0, sel.offsetLeft - dateStripEl.offsetLeft);
    if (smooth && dateStripEl.scrollTo) {
      try {
        dateStripEl.scrollTo({ left: target, behavior: 'smooth' });
        return;
      } catch (e) {}
    }
    dateStripEl.scrollLeft = target;
  }

  function paintDateStrip() {
    if (!dateStripEl) return;
    dateStripEl.innerHTML = buildDateStripHtml();
    scrollDateStripToSelected(false);
  }

  function selectedPeople() {
    var peopleSel = browseFilterEl('people');
    var n = peopleSel ? parseInt(peopleSel.value || '0', 10) : 0;
    return n > 0 ? n : 0;
  }

  function browsePeopleCap() {
    var fleetMax = charterFilterPeopleMax(tenant);
    var boatSel = browseFilterEl('boat');
    var boatVal = boatSel ? String(boatSel.value || '') : '';
    if (boatVal) {
      var b = charterBoatById(tenant, boatVal);
      var cap = b ? Number(b.maxPeople) : 0;
      if (cap > 0) return Math.min(cap, fleetMax);
    }
    return fleetMax;
  }

  function browseFiltersIncompatible() {
    var ppl = selectedPeople();
    var boatSel = browseFilterEl('boat');
    var boatVal = boatSel ? String(boatSel.value || '') : '';
    if (!ppl || !boatVal) return false;
    var b = charterBoatById(tenant, boatVal);
    if (!b) return false;
    var cap = Number(b.maxPeople) || 0;
    return cap > 0 && ppl > cap;
  }

  function syncBrowseFilterSelects() {
    var fleetMax = charterFilterPeopleMax(tenant);
    var cur = selectedPeople();
    var boatSel = browseFilterEl('boat');
    var boatVal = boatSel ? String(boatSel.value || '') : '';
    if (cur > 0 && boatVal) {
      var picked = charterBoatById(tenant, boatVal);
      if (picked && Number(picked.maxPeople) > 0 && cur > Number(picked.maxPeople)) {
        browseSyncFilters('boat', '');
      }
    }
    var peopleSels = browseFilterEls('people');
    if (peopleSels.length) {
      var cap = browsePeopleCap();
      var html = '<option value="">Any party</option>';
      for (var gp = 1; gp <= cap; gp++) {
        html += '<option value="' + gp + '">' + gp + (gp === 1 ? ' person' : ' people') + '</option>';
      }
      for (var pi = 0; pi < peopleSels.length; pi++) {
        peopleSels[pi].innerHTML = html;
        if (cur > 0 && cur <= cap) peopleSels[pi].value = String(cur);
      }
    }
    var boatSels = browseFilterEls('boat');
    var ppl = selectedPeople();
    for (var bi = 0; bi < boatSels.length; bi++) {
      var boatEl = boatSels[bi];
      for (var bj = 1; bj < boatEl.options.length; bj++) {
        var opt = boatEl.options[bj];
        var boat = charterBoatById(tenant, opt.value);
        var maxP = boat ? Number(boat.maxPeople) : 0;
        opt.disabled = ppl > 0 && maxP > 0 && ppl > maxP;
      }
    }
  }

  function maxPeopleForFilteredTrip(s) {
    var boatSel = browseFilterEl('boat');
    var boatVal = boatSel ? String(boatSel.value || '') : '';
    if (boatVal) {
      var b = charterBoatById(tenant, boatVal);
      var cap = b ? Number(b.maxPeople) : 0;
      if (cap > 0) return cap;
    }
    return charterMaxPeopleForTrip(tenant, s);
  }

  function fitOptsForService(s) {
    return {
      occupancy: tenant._charterOccupancy || [],
      people: selectedPeople(),
      startMin: startMin,
      maxPeople: maxPeopleForFilteredTrip(s),
      service: s,
      boatFilterId: (function() {
        var boatSel = browseFilterEl('boat');
        return boatSel ? String(boatSel.value || '') : '';
      })()
    };
  }

  function tripMatchesDropdowns(mins, tripKey, boatIdsRaw) {
    var typeSel = browseFilterEl('trip');
    var durSel = browseFilterEl('dur');
    var boatSel = browseFilterEl('boat');
    var typeVal = typeSel ? String(typeSel.value || '') : '';
    var durVal = durSel ? String(durSel.value || '') : '';
    var boatVal = boatSel ? String(boatSel.value || '') : '';
    var ppl = selectedPeople();
    if (typeVal && String(tripKey || '') !== typeVal) return false;
    if (durVal && charterDurationFilterKey(mins) !== durVal) return false;
    if (boatVal) {
      var ids = Array.isArray(boatIdsRaw)
        ? boatIdsRaw
        : String(boatIdsRaw || '').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
      if (ids.indexOf(boatVal) < 0) return false;
      if (ppl > 0) {
        var pickedBoat = charterBoatById(tenant, boatVal);
        if (pickedBoat && Number(pickedBoat.maxPeople) > 0 && ppl > Number(pickedBoat.maxPeople)) return false;
      }
    }
    if (ppl > 0) {
      var tripBoatIds = Array.isArray(boatIdsRaw)
        ? boatIdsRaw
        : String(boatIdsRaw || '').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
      if (tripBoatIds.length) {
        var fitsParty = false;
        for (var ti = 0; ti < tripBoatIds.length; ti++) {
          var tb = charterBoatById(tenant, tripBoatIds[ti]);
          if (tb && Number(tb.maxPeople) >= ppl) { fitsParty = true; break; }
        }
        if (!fitsParty) return false;
      }
    }
    return true;
  }

  function dayHasMatchingTrip(date) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var tripKey = String(s.name || '').trim().toLowerCase();
      var mins = Number(s.durationMinutes) || 0;
      if (!tripMatchesDropdowns(mins, tripKey, charterServiceBoatIds(s))) continue;
      if (charterTripFitsDate(tenant, date, mins, fitOptsForService(s))) return true;
    }
    return false;
  }

  function firstOpenIsoInView() {
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (var d = 1; d <= daysInMonth; d++) {
      var date = new Date(viewYear, viewMonth, d);
      if (dayHasMatchingTrip(date)) return calendarIsoDate(date);
    }
    return '';
  }

  function syncBrowseUrl() {
    try {
      var url = new URL(location.href);
      if (selectedIso) url.searchParams.set('date', selectedIso);
      else url.searchParams.delete('date');
      var boatVal = (function() {
        var boatSel = browseFilterEl('boat');
        return boatSel ? String(boatSel.value || '') : '';
      })();
      if (boatVal) url.searchParams.set('boat', boatVal);
      else url.searchParams.delete('boat');
      var ppl = selectedPeople();
      if (ppl > 0) url.searchParams.set('people', String(ppl));
      else url.searchParams.delete('people');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  if (selectedIso) {
    var jump = charterDateFromIso(selectedIso);
    if (jump) {
      viewYear = jump.getFullYear();
      viewMonth = jump.getMonth();
    }
    browseNeedsDefaultDate = false;
  }

  function formatOpenDayLabel(date) {
    if (!date) return '';
    var wd = date.toLocaleDateString('en-US', { weekday: 'short' }).replace(/\./g, '').toUpperCase();
    return wd + ' ' + date.getDate();
  }

  function formatBrowseOpenCount(shown, selDate) {
    if (!selDate) return shown === 1 ? '1 CHARTER' : (shown + ' CHARTERS');
    var dayPart = formatOpenDayLabel(selDate);
    var noun = shown === 1 ? '1 CHARTER' : (shown + ' CHARTERS');
    return noun + ' OPEN ' + dayPart;
  }

  function monthApplyLabel(shown, selDate) {
    if (!selDate) {
      return webCopyOverrideText(tenant, 'wc.charter.browseShowCharters', 'Show charters');
    }
    var dayLabel = selDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (shown <= 0) {
      return 'No charters on ' + dayLabel;
    }
    var noun = shown === 1 ? '1 charter' : (shown + ' charters');
    return 'Show ' + noun + ' on ' + dayLabel;
  }

  function setMonthSheetOpen(open) {
    if (!monthSheet) return;
    if (open) {
      monthSheet.removeAttribute('hidden');
      monthSheet.setAttribute('aria-hidden', 'false');
      document.body.classList.add('charter-month-sheet-open');
    } else {
      monthSheet.setAttribute('hidden', 'hidden');
      monthSheet.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('charter-month-sheet-open');
    }
  }

  function updateMonthApplyLabel() {
    if (!monthApplyBtn) return;
    var selDate = charterDateFromIso(selectedIso);
    var shown = 0;
    if (selDate) {
      var rows = listEl.querySelectorAll('[data-charter-row]');
      for (var ri = 0; ri < rows.length; ri++) {
        if (!rows[ri].hidden) shown += 1;
      }
    }
    monthApplyBtn.textContent = monthApplyLabel(shown, selDate);
  }

  function setEditableStatus(el, key, fallback) {
    if (el) el.innerHTML = wcSpan(tenant, key, fallback);
  }

  function applyFilters() {
    var selDate = charterDateFromIso(selectedIso);
    var rows = listEl.querySelectorAll('[data-charter-row]');
    if (!charterHasFleet(tenant)) {
      for (var i = 0; i < rows.length; i++) rows[i].hidden = true;
      if (emptyEl) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = wcSpan(tenant, 'wc.charter.browseNoFleet', charterNoFleetMessage());
      }
      setEditableStatus(countEl, 'wc.charter.browseNotAvailable', 'NOT AVAILABLE YET');
      updateMonthApplyLabel();
      return;
    }
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var trip = String(row.getAttribute('data-charter-trip') || '');
      var mins = Number(row.getAttribute('data-charter-mins') || 0);
      var slug = String(row.getAttribute('data-charter-slug') || '');
      var boatIds = String(row.getAttribute('data-charter-boats') || '');
      var ok = false;
      var svc = null;
      for (var s = 0; s < list.length; s++) {
        if (String(list[s].slug || '') === slug) { svc = list[s]; break; }
      }
      if (selDate && tripMatchesDropdowns(mins, trip, boatIds) && charterTripFitsDate(tenant, selDate, mins, fitOptsForService(svc))) {
        ok = true;
      }
      row.hidden = !ok;
      var boatVal = (function() {
        var boatSel = browseFilterEl('boat');
        return boatSel ? String(boatSel.value || '') : '';
      })();
      var ppl = selectedPeople();
      var tripHref = charterSearchHref(tenant, {
        slug: slug,
        date: selectedIso || '',
        time: '',
        boat: boatVal,
        people: ppl
      });
      var links = row.querySelectorAll('[data-charter-trip-link]');
      for (var li = 0; li < links.length; li++) links[li].setAttribute('href', tripHref);
      var submetaEl = row.querySelector('[data-charter-submeta]');
      if (submetaEl) {
        submetaEl.textContent = ok && svc ? charterBrowseSubmetaText(svc, boatVal) : '';
      }
      var timesEl = row.querySelector('[data-charter-times]');
      var moreEl = row.querySelector('[data-charter-times-more]');
      if (timesEl) {
        timesEl.innerHTML = '';
        if (moreEl) {
          moreEl.hidden = true;
          moreEl.textContent = '';
          moreEl.onclick = null;
        }
        if (ok && selDate && svc) {
          var starts = charterOpenStartsForTrip(tenant, selDate, mins, {
            occupancy: tenant._charterOccupancy || [],
            people: ppl,
            maxPeople: maxPeopleForFilteredTrip(svc),
            service: svc,
            boatFilterId: boatVal
          }).filter(function(t) { return t % 30 === 0; });
          var visibleMax = 3;
          var visibleStarts = starts.slice(0, visibleMax);
          var hiddenCount = Math.max(0, starts.length - visibleMax);
          function timeLinkHtml(t) {
            return '<a class="charter-browse-time" href="' +
              esc(charterSearchHref(tenant, {
                slug: slug,
                date: selectedIso || '',
                time: charterMinToHHmm(t),
                boat: boatVal,
                people: ppl
              })) + '">' + esc(charterFormatMin(t)) + '</a>';
          }
          timesEl.innerHTML = visibleStarts.map(timeLinkHtml).join('');
          if (moreEl && hiddenCount > 0) {
            moreEl.hidden = false;
            moreEl.textContent = '+' + hiddenCount + ' more';
            moreEl.onclick = function() {
              timesEl.innerHTML = starts.map(timeLinkHtml).join('');
              moreEl.hidden = true;
            };
          }
        }
      }
      if (ok) shown += 1;
    }
    if (emptyEl) {
      if (!tenant._charterOccupancyReady) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = wcSpan(tenant, 'wc.charter.browseLoading', 'Loading live availability…');
      } else if (tenant._charterOccupancyFailed) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = wcSpan(tenant, 'wc.charter.browseUnavailable',
          'Live availability is temporarily unavailable. Please refresh and try again.');
      } else if (!list.length) {
        emptyEl.hidden = true;
      } else if (!selDate) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = wcSpan(tenant, 'wc.charter.browsePickOpenDay', 'Pick an open day to see charters.');
      } else if (browseFiltersIncompatible()) {
        emptyEl.hidden = false;
        emptyEl.innerHTML = wcSpan(tenant, 'wc.charter.browsePartyTooLarge',
          'This boat cannot fit your party size. Try a larger boat or fewer people.');
      } else {
        emptyEl.hidden = shown > 0;
        emptyEl.innerHTML = wcSpan(tenant, 'wc.charter.browseNoneOpen', 'No charters are open on this day.');
      }
    }
    if (countEl) {
      if (!tenant._charterOccupancyReady) setEditableStatus(countEl, 'wc.charter.browseLoadingLabel', 'LOADING AVAILABILITY');
      else if (tenant._charterOccupancyFailed) setEditableStatus(countEl, 'wc.charter.browseUnavailableLabel', 'AVAILABILITY UNAVAILABLE');
      else if (!selDate) setEditableStatus(countEl, 'wc.charter.browsePickDayLabel', 'PICK A DAY');
      else countEl.textContent = formatBrowseOpenCount(shown, selDate);
    }
    updateMonthApplyLabel();
    paintFilterChips();
  }

  function buildMonthGridHtml() {
    var first = new Date(viewYear, viewMonth, 1);
    var startPad = first.getDay();
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var html = ['S','M','T','W','T','F','S'].map(function(w) {
      return '<span class="wd">' + w + '</span>';
    }).join('');
    var i;
    for (i = 0; i < startPad; i++) html += '<span class="pad"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var date = new Date(viewYear, viewMonth, d);
      var iso = calendarIsoDate(date);
      var open = dayHasMatchingTrip(date);
      var cls = open ? 'open' : 'closed';
      if (iso === selectedIso) cls += ' sel';
      html += '<button type="button" class="' + cls + '" data-charter-cal-day="' + iso + '"' +
        (open ? '' : ' disabled') + '>' + d + '</button>';
    }
    return html;
  }

  function paintMonth() {
    var title = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric'
    });
    document.querySelectorAll('[data-charter-cal-title]').forEach(function(el) {
      el.textContent = title;
    });
    if (titleSheetEl) titleSheetEl.textContent = title;
    var key = viewYear * 12 + viewMonth;
    if (prevBtn) prevBtn.disabled = key <= minKey;
    if (nextBtn) nextBtn.disabled = key >= maxKey;
    if (prevSheetBtn) prevSheetBtn.disabled = key <= minKey;
    if (nextSheetBtn) nextSheetBtn.disabled = key >= maxKey;
    var html = buildMonthGridHtml();
    if (grid) grid.innerHTML = html;
    if (gridSheet) gridSheet.innerHTML = html;
  }

  function openMonthSheet() {
    var sel = charterDateFromIso(selectedIso);
    if (sel) {
      viewYear = sel.getFullYear();
      viewMonth = sel.getMonth();
      paintMonth();
    }
    setMonthSheetOpen(true);
    updateMonthApplyLabel();
  }

  function ensureDefaultBrowseDate() {
    if (!browseNeedsDefaultDate || !charterHasFleet(tenant) || selectedIso) return;
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    selectedIso = calendarIsoDate(today);
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    browseNeedsDefaultDate = false;
    syncBrowseUrl();
  }

  function refreshBrowse() {
    ensureDefaultBrowseDate();
    syncBrowseFilterSelects();
    paintMonth();
    paintDateStrip();
    paintFilterChips();
    applyFilters();
  }

  function selectIso(iso) {
    browseNeedsDefaultDate = false;
    selectedIso = iso || '';
    var jump = charterDateFromIso(selectedIso);
    if (jump) {
      viewYear = jump.getFullYear();
      viewMonth = jump.getMonth();
    }
    syncBrowseUrl();
    refreshBrowse();
  }

  function shiftMonth(delta) {
    var key = viewYear * 12 + viewMonth + delta;
    if (key < minKey || key > maxKey) return;
    viewMonth += delta;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    else if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    var sel = charterDateFromIso(selectedIso);
    var keep = sel && sel.getFullYear() === viewYear && sel.getMonth() === viewMonth;
    if (!keep) {
      selectedIso = firstOpenIsoInView();
      if (!selectedIso) {
        var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        var todayD = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        for (var md = 1; md <= daysInMonth; md++) {
          var probe = new Date(viewYear, viewMonth, md);
          if (probe >= todayD) {
            selectedIso = calendarIsoDate(probe);
            break;
          }
        }
      }
      browseNeedsDefaultDate = false;
    }
    syncBrowseUrl();
    refreshBrowse();
  }

  function bindCalDayClick(container) {
    if (!container) return;
    container.addEventListener('click', function(ev) {
      var t = ev.target;
      if (t && t.nodeType === 3) t = t.parentElement;
      var btn = t && t.closest ? t.closest('[data-charter-cal-day]') : null;
      if (!btn || btn.disabled || btn.getAttribute('disabled') != null) return;
      var iso = String(btn.getAttribute('data-charter-cal-day') || '');
      if (!iso) return;
      selectIso(iso);
    });
  }

  bindCalDayClick(grid);
  bindCalDayClick(gridSheet);
  if (prevBtn) prevBtn.addEventListener('click', function() { shiftMonth(-1); });
  if (nextBtn) nextBtn.addEventListener('click', function() { shiftMonth(1); });
  if (prevSheetBtn) prevSheetBtn.addEventListener('click', function() { shiftMonth(-1); });
  if (nextSheetBtn) nextSheetBtn.addEventListener('click', function() { shiftMonth(1); });
  if (monthCloseBtn) monthCloseBtn.addEventListener('click', function() { setMonthSheetOpen(false); });
  if (monthApplyBtn) {
    monthApplyBtn.addEventListener('click', function() {
      setMonthSheetOpen(false);
      syncBrowseUrl();
    });
  }
  if (dateStripEl) {
    dateStripEl.addEventListener('click', function(ev) {
      var t = ev.target;
      if (t && t.nodeType === 3) t = t.parentElement;
      var btn = t && t.closest ? t.closest('[data-charter-strip-day]') : null;
      if (!btn || btn.disabled || btn.getAttribute('disabled') != null) return;
      var iso = String(btn.getAttribute('data-charter-strip-day') || '');
      if (!iso) return;
      selectIso(iso);
    });
  }
  if (monthOpenBtn) monthOpenBtn.addEventListener('click', openMonthSheet);
  if (filterChips) {
    filterChips.addEventListener('click', function(ev) {
      var chip = ev.target && ev.target.closest ? ev.target.closest('[data-charter-chip]') : null;
      if (!chip) return;
      setFilterSheetOpen(true);
    });
  }
  if (filterCloseBtn) {
    filterCloseBtn.addEventListener('click', function() { setFilterSheetOpen(false); });
  }
  var filterInputs = document.querySelectorAll('[data-charter-trip-filter], [data-charter-dur-filter], [data-charter-people-filter], [data-charter-boat-filter]');
  for (var f = 0; f < filterInputs.length; f++) {
    filterInputs[f].addEventListener('change', function() {
      var el = this;
      if (el.hasAttribute('data-charter-trip-filter')) browseSyncFilters('trip', el.value, el);
      else if (el.hasAttribute('data-charter-dur-filter')) browseSyncFilters('dur', el.value, el);
      else if (el.hasAttribute('data-charter-people-filter')) browseSyncFilters('people', el.value, el);
      else if (el.hasAttribute('data-charter-boat-filter')) browseSyncFilters('boat', el.value, el);
      if (selectedIso) {
        var sel = charterDateFromIso(selectedIso);
        if (!sel || !dayHasMatchingTrip(sel)) selectedIso = firstOpenIsoInView();
        syncBrowseUrl();
      }
      setFilterSheetOpen(false);
      refreshBrowse();
    });
  }
  for (var c = 0; c < clearBtns.length; c++) {
    clearBtns[c].addEventListener('click', function() {
      selectedIso = '';
      browseNeedsDefaultDate = true;
      browseSyncFilters('trip', '');
      browseSyncFilters('dur', '');
      browseSyncFilters('people', '');
      browseSyncFilters('boat', '');
      setFilterSheetOpen(false);
      syncBrowseUrl();
      refreshBrowse();
    });
  }
  syncBrowseUrl();
  refreshBrowse();
  charterBindOccupancyLifecycle(tenant, refreshBrowse);
  charterLoadOccupancy(tenant, { force: true }).then(refreshBrowse).catch(refreshBrowse);
}

function charterDetailPage(tenant, service, services) {
  var base = tenantBaseUrl(tenant);
  var s = service || (services && services[0]) || { name: 'Half-Day Reef Charter', description: 'A half-day run out to the reef.', durationMinutes: 240, price: 450 };
  var sid = s.id || s.slug || '0';
  var price = charterPriceLabel(s) || '$450';
  var dur = charterDurationLabel(s) || 'Half-day trip';
  var area = (tenant.serviceArea || '').toString().trim() || 'Key West, FL';
  var feats = (tenant.featuredWorkImages || tenant.galleryImages || []);
  var serviceImage = s.imageUrl || s.photoUrl || '';
  var selectedServiceIndex = Math.max(0, (services || []).findIndex(function(candidate) {
    return candidate === s ||
      String(candidate.id || candidate.slug || '') === String(s.id || s.slug || '');
  }));
  var mainFeaturedIndex = selectedServiceIndex;
  var mainImg = serviceImage ||
    (feats[mainFeaturedIndex] && (feats[mainFeaturedIndex].url || feats[mainFeaturedIndex])) ||
    tenant.heroImageUrl || '';
  var sideIndices = [];
  for (var fi = 0; fi < feats.length && sideIndices.length < 2; fi++) {
    if (!serviceImage && fi === mainFeaturedIndex) continue;
    sideIndices.push(fi);
  }
  var sideIndex2 = sideIndices.length ? sideIndices[0] : (mainFeaturedIndex === 0 ? 1 : 0);
  var sideIndex3 = sideIndices.length > 1 ? sideIndices[1] : (sideIndex2 === 1 ? 2 : 1);
  var img2 = (feats[sideIndex2] && (feats[sideIndex2].url || feats[sideIndex2])) || '';
  var img3 = (feats[sideIndex3] && (feats[sideIndex3].url || feats[sideIndex3])) || '';
  // Never leave the lead gallery cell empty — promote the first available photo.
  if (!mainImg) {
    mainImg = img2 || img3 || '';
    if (img2 && mainImg === img2) img2 = img3 || '';
    if (img3 && mainImg === img3) img3 = '';
  }
  var search = charterSearchQuery();
  var dateIso = search.date;
  var maxGuests = charterMaxPeopleForTrip(tenant, s) || 12;
  var peopleVal = search.people > 0 ? Math.min(search.people, maxGuests) : Math.min(2, maxGuests);
  var guestOpts = '';
  for (var g = 1; g <= maxGuests; g++) {
    guestOpts += '<option value="' + g + '"' + (g === peopleVal ? ' selected' : '') + '>' +
      g + (g === 1 ? ' angler' : ' anglers') + '</option>';
  }
  var bookHref = charterBookHref(tenant, s, {
    date: dateIso,
    time: search.time || '',
    people: peopleVal
  });
  var ownerName = tenant.displayName || tenant.businessName || 'Captain';
  function featSlot(idx, url, editable) {
    if (url) {
      return '<img' + (editable === false ? '' : ' data-edit-key="featuredWork:' + idx + '"') +
        ' src="' + esc(typeof url === 'string' ? url : '') + '" alt="">';
    }
    return '<div data-edit-key="featuredWork:' + idx + '" class="charter-photo-slot" role="button" aria-label="Add photo"></div>';
  }
  var itineraryHtml = '<div class="charter-itinerary">' +
    '<h4>' + wcSpan(tenant, 'wc.charter.itineraryLabel', 'Itinerary') + '</h4>' +
    '<div class="charter-itinerary-list" data-charter-itinerary-list>' +
      charterItineraryListHtml(s, search.time || '') +
    '</div></div>';
  var bookHtml = tenantShowBookPage(tenant)
    ? charterKeyedCardBandHtml(tenant, 'charter.stickyBook', 'charter-blueprint charter-sticky-book elev-md',
      '<div class="price">' + esc(price) + ' <span class="per">/ trip</span></div>' +
      '<div class="charter-field"><label>Date</label>' +
        '<input type="date" data-charter-detail-date value="' + esc(dateIso) + '"></div>' +
      '<div class="charter-field"><label>Departure</label>' +
        '<select data-charter-detail-time><option value="">Choose a time</option></select></div>' +
      '<div class="charter-field"><label>Guests</label>' +
        '<select data-charter-detail-people>' + guestOpts + '</select></div>' +
      '<p class="charter-browse-empty" data-charter-detail-hint hidden></p>' +
      '<a class="charter-btn charter-btn-block" data-cta-key="wc.charter.continueBook" data-charter-detail-continue href="' + esc(bookHref) + '">' +
        wcSpan(tenant, 'wc.charter.continueBook', 'Continue to booking') + '</a>',
      ' data-charter-detail-book="1"')
    : '';
  var galleryHtml = '<div class="charter-detail-gallery">' +
    '<div class="charter-blueprint main">' + featSlot(mainFeaturedIndex, mainImg, !serviceImage) + '</div>' +
    '<div class="side">' +
      '<div class="charter-blueprint">' + featSlot(sideIndex2, img2, true) + '</div>' +
      '<div class="charter-blueprint">' + featSlot(sideIndex3, img3, true) + '</div>' +
    '</div></div>';
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'charters') +
    charterRouteCanvasOpen(tenant, 'charter.tripPage') +
    '<div class="charter-detail-crumbs">' +
      '<a class="charter-back" href="' + esc(charterSearchHref(tenant, { date: dateIso || '', time: '', people: search.people || 0, boat: search.boat || '' })) + '">‹ Charters</a>' +
      '<span> / ' + esc(s.name || 'Trip') + '</span>' +
    '</div>' +
    '<div class="charter-detail-top">' +
      '<div class="charter-detail-lead"' + svcEditAttr(sid) + '>' +
        '<h1>' + (sid ? svcSpan(tenant, sid, 'name', s.name || 'Charter') : esc(s.name || 'Charter')) + '</h1>' +
        '<div class="charter-meta">' + svcSpan(tenant, sid, 'duration', dur || 'Trip') + '</div>' +
        '<div class="charter-tags">' +
          '<span class="charter-tag">' + wcSpan(tenant, 'wc.charter.tag0', 'Reef fishing') + '</span>' +
          '<span class="charter-tag charter-tag-outline">' + wcSpan(tenant, 'wc.charter.tag1', 'Gear included') + '</span>' +
          '<span class="charter-tag charter-tag-outline">' + wcSpan(tenant, 'wc.charter.tag2', 'Licensed & insured') + '</span>' +
        '</div>' +
        itineraryHtml +
        bookHtml +
      '</div>' +
      galleryHtml +
    '</div>' +
    '<div class="charter-detail-body"' + charterBandAttrs(tenant, 'card', 'charter.tripBody') + '>' +
      charterKeyedCardBandHtml(tenant, 'charter.captain', 'charter-blueprint charter-captain',
        '<div class="charter-captain-avatar"></div>' +
        '<div style="flex:1"><div class="charter-card-title charter-captain-name" style="font-size:16px">' +
          wcSpan(tenant, 'wc.charter.captainName', ownerName) + '</div>' +
        '<div style="font-size:13px;opacity:.65">' + wcSpan(tenant, 'wc.charter.captainRole', 'Captain · local waters') + '</div></div>') +
      '<div>' +
        '<h4 style="margin:0 0 6px">' + wcSpan(tenant, 'wc.charter.aboutTripLabel', 'About this trip') + '</h4>' +
        '<p style="font-size:14px;opacity:.8;margin:0">' +
          esc(s.description || 'A half-day run out to the reef. Rods, bait, ice and license covered — just bring sunscreen and a cooler for the catch.') +
        '</p>' +
      '</div>' +
    '</div>' +
    '</div>' +
    charterFooterHtml(tenant) +
    '</div>';
}

function bindCharterDetail(tenant, service) {
  var dateEl = document.querySelector('[data-charter-detail-date]');
  var timeEl = document.querySelector('[data-charter-detail-time]');
  var peopleEl = document.querySelector('[data-charter-detail-people]');
  var btn = document.querySelector('[data-charter-detail-continue]');
  var hint = document.querySelector('[data-charter-detail-hint]');
  if (!dateEl || !timeEl || !btn) return;
  var dur = Number(service && service.durationMinutes) || 240;
  var search = charterSearchQuery();
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var max = new Date(today);
  max.setMonth(max.getMonth() + 6);
  dateEl.min = calendarIsoDate(today);
  dateEl.max = calendarIsoDate(max);
  if (!dateEl.value && search.date) dateEl.value = search.date;

  function showHint(msg) {
    if (!hint) return;
    if (!msg) { hint.hidden = true; hint.textContent = ''; return; }
    hint.hidden = false;
    hint.textContent = msg;
  }

  function extras() {
    return {
      date: String(dateEl.value || '').trim(),
      time: String(timeEl.value || '').trim(),
      people: parseInt(peopleEl && peopleEl.value ? peopleEl.value : '2', 10),
      duration: dur
    };
  }

  function paintItinerary() {
    var list = document.querySelector('[data-charter-itinerary-list]');
    if (!list) return;
    list.innerHTML = charterItineraryListHtml(service, String(timeEl.value || ''));
  }

  function syncContinue() {
    var x = extras();
    btn.setAttribute('href', charterBookHref(tenant, service, x));
    var ready = !!x.date && !!x.time && x.people > 0 && charterHasFleet(tenant);
    btn.style.opacity = ready ? '1' : '0.55';
    btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
    paintItinerary();
  }

  function fillTimes() {
    var prev = String(timeEl.value || search.time || '');
    var date = charterDateFromIso(dateEl.value);
    var people = parseInt(peopleEl && peopleEl.value ? peopleEl.value : '0', 10);
    timeEl.innerHTML = '<option value="">Choose a time</option>';
    if (!date) {
      showHint('Pick an open day.');
      syncContinue();
      return;
    }
    if (!charterHasFleet(tenant)) {
      showHint(charterNoFleetMessage());
      syncContinue();
      return;
    }
    if (tenant._charterOccupancyFailed) {
      showHint('Live availability is temporarily unavailable. Please refresh and try again.');
      syncContinue();
      return;
    }
    var starts = charterOpenStartsForTrip(tenant, date, dur, {
      people: people,
      maxPeople: charterMaxPeopleForTrip(tenant, service),
      service: service,
      boatFilterId: search.boat || ''
    });
    if (!starts.length) {
      showHint('No departure times on this day. Pick another open day.');
      syncContinue();
      return;
    }
    showHint('');
    var i;
    for (i = 0; i < starts.length; i++) {
      var val = charterMinToHHmm(starts[i]);
      var opt = document.createElement('option');
      opt.value = val;
      opt.textContent = charterFormatMin(starts[i]);
      if (val === prev) opt.selected = true;
      timeEl.appendChild(opt);
    }
    if (!timeEl.value && starts.length === 1) timeEl.value = charterMinToHHmm(starts[0]);
    syncContinue();
  }

  dateEl.addEventListener('change', fillTimes);
  if (peopleEl) peopleEl.addEventListener('change', fillTimes);
  timeEl.addEventListener('change', syncContinue);
  btn.addEventListener('click', function(ev) {
    syncContinue();
    if (btn.getAttribute('aria-disabled') === 'true') {
      ev.preventDefault();
      showHint('Choose a date and departure time to continue.');
    }
  });

  function start() {
    fillTimes();
  }
  showHint('Loading live availability…');
  charterBindOccupancyLifecycle(tenant, start);
  charterLoadOccupancy(tenant, { force: true }).then(start).catch(start);
}

function charterHowItWorksPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var steps = charterDefaultSteps(tenant);
  var stepsHtml = steps.map(function(s, i) {
    var idx = String(s.editTitle || '').split(':')[1];
    if (idx == null || idx === '') idx = String(i);
    return charterKeyedCardBandHtml(tenant, 'charter.howStep.' + idx, 'charter-blueprint charter-step',
      '<div class="n">' + wcSpan(tenant, 'wc.charter.step' + idx + '.n', s.n) + '</div>' +
      '<div class="charter-card-title" style="margin-bottom:6px">' + s12ProcessSpan(idx, 'title', s.title) + '</div>' +
      '<div style="opacity:.75">' + s12ProcessSpan(idx, 'body', s.desc) + '</div>',
      ' data-edit-key="s12Process:' + idx + ':edit"');
  }).join('');
  var faqs = charterFaqsForTenant(tenant);
  var faqHtml = faqs.map(function(f, i) {
    return '<div class="charter-faq-item" data-edit-key="charterFaq:' + i + ':edit">' +
      '<h4>' + '<span data-edit-key="charterFaq:' + i + ':question">' + esc(f.q) + '</span></h4>' +
      '<p>' + '<span data-edit-key="charterFaq:' + i + ':answer">' + esc(f.a).replace(/\n/g, '<br>') + '</span></p></div>';
  }).join('');
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'how') +
    charterRouteCanvasOpen(tenant, 'charter.howPage') +
    '<section class="charter-section" style="text-align:center;padding-bottom:8px">' +
      '<div class="charter-sec-label charter-sec-label--ink">' + wcSpan(tenant, 'wc.charter.howLabel', 'How it works') + '</div>' +
      '<h1 class="charter-sec-heading" style="max-width:600px;margin:0 auto 12px">' +
        wcSpan(tenant, 'wc.charter.howHeading', "Booking a charter shouldn't be complicated") + '</h1>' +
      '<p style="max-width:520px;margin:0 auto;opacity:.7;font-size:15px">' +
        wcSpan(tenant, 'wc.charter.howSub', 'Three steps between you and a day on the water.') + '</p>' +
    '</section>' +
    '<section class="charter-section"' + charterBandAttrs(tenant, 'card', 'charter.howSteps') + '><div class="charter-steps">' + stepsHtml + '</div></section>' +
    '<section class="charter-section"' + charterBandAttrs(tenant, 'card', 'charter.faq') + '>' +
      '<h3 class="charter-sec-heading" style="margin-bottom:20px">' + wcSpan(tenant, 'wc.charter.faqHeading', 'Frequently asked') + '</h3>' +
      '<div class="charter-faq">' + faqHtml + '</div>' +
    '</section>' +
    '<section class="charter-section" style="text-align:center"' + charterBandAttrs(tenant, 'page', 'charter.howCta') + '>' +
      '<h2 class="charter-sec-heading" style="margin-bottom:16px">' + wcSpan(tenant, 'wc.charter.howCtaHeading', 'Ready to get on the water?') + '</h2>' +
      '<a class="charter-btn" href="' + base + '/charters" style="height:46px;padding:0 28px" data-cta-key="wc.charter.howCta">' +
        wcSpan(tenant, 'wc.charter.howCta', 'Browse charters') + '</a>' +
    '</section>' +
    '</div>' +
    charterFooterHtml(tenant) +
    '</div>';
}

function charterAboutPage(tenant) {
  var about = (tenant.aboutText || '').toString().trim()
    || 'Private fishing charters planned around your group, the conditions, and the day you want on the water.';
  var aboutImg = (tenant.classicAboutImageUrl || tenant.heroImageUrl || '').toString().trim();
  var photoHtml = aboutImg
    ? '<img class="charter-about-photo" data-edit-key="classicAboutImage" src="' + esc(aboutImg) + '" alt="">'
    : '<div class="charter-about-photo charter-about-photo--empty" data-edit-key="classicAboutImage" role="button" aria-label="Add about photo"></div>';
  var showCaptain = tenant.showCharterContactCaptain === true;
  var smsPhone = (tenant.smsPhoneNumber || '').toString().trim();
  var contactPhone = (tenant.contactPhone || '').toString().trim();
  var useTwilio = tenantClientSmsActive(tenant) &&
    !!smsHrefFromPhone(smsPhone);
  var captainPhone = useTwilio ? smsPhone : contactPhone;
  var smsHref = smsHrefFromPhone(captainPhone, 'Hi Captain — I have a question about your charters.');
  var captainHtml = '';
  if (showCaptain && smsHref) {
    var phoneLabel = displayPhoneUS(captainPhone) || captainPhone;
    var bodyDefault = useTwilio
      ? 'Questions before you book? Text this number — reply YES when asked so the captain can message you back.'
      : 'Questions before you book? Text the captain at this number.';
    var bodyKey = useTwilio ? 'wc.charter.contactCaptainBody' : 'wc.charter.contactCaptainBodyPersonal';
    captainHtml =
      charterKeyedCardBandHtml(tenant, 'charter.aboutContact', 'charter-blueprint charter-about-contact',
        '<div class="charter-card-title" style="font-size:16px;margin-bottom:6px">' +
          wcSpan(tenant, 'wc.charter.contactCaptainHeading', 'Contact the captain') +
        '</div>' +
        '<p style="margin:0 0 14px;font-size:14px;line-height:1.5;opacity:.8">' +
          wcSpan(tenant, bodyKey, bodyDefault) +
        '</p>' +
        '<a class="charter-btn" href="' + esc(smsHref) + '" data-cta-key="wc.charter.contactCaptainCta">' +
          wcSpan(tenant, 'wc.charter.contactCaptainCta', 'Text the captain') +
        '</a>' +
        '<div class="charter-about-contact-number">' + esc(phoneLabel) + '</div>');
  }
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'about') +
    '<section class="charter-section charter-about-section"' + charterBandAttrs(tenant, 'about', 'charter.aboutPage') + '>' +
      '<div class="charter-about-layout">' +
        '<div class="charter-about-copy">' +
          '<div class="charter-about-heading">' +
            '<div class="charter-sec-label charter-sec-label--ink">' + wcSpan(tenant, 'wc.charter.aboutLabel', 'About') + '</div>' +
            '<h1 class="charter-about-title charter-sec-heading">' + siteNameSpan(tenant, 'Harbor Charters') + '</h1>' +
          '</div>' +
          '<div class="charter-about-story">' +
            '<p data-edit-key="aboutText" class="charter-about-text">' + esc(about) + '</p>' +
            captainHtml +
            charterInstagramLinkHtml(tenant, 'charter-about-instagram') +
          '</div>' +
        '</div>' +
        '<div class="charter-about-media">' + photoHtml + '</div>' +
      '</div>' +
    '</section>' +
    charterFooterHtml(tenant) +
    '</div>';
}

function charterCheckoutNavHtml(tenant, service) {
  var q = charterSearchQuery();
  var back = (service && service.slug)
    ? charterSearchHref(tenant, {
        slug: service.slug,
        date: q.date || '',
        time: q.time || '',
        people: q.people || 0,
        boat: q.boat || ''
      })
    : charterSearchHref(tenant, {
        date: q.date || '',
        time: '',
        people: q.people || 0,
        boat: q.boat || ''
      });
  return '<nav class="charter-nav"' + charterBandAttrs(tenant, 'page', 'charter.nav') + '>' +
    '<a class="charter-back charter-back--nav" href="' + esc(back) + '">‹ Back</a>' +
    '<a href="' + tenantBaseUrl(tenant) + '/home" class="charter-brand">' + siteNameSpan(tenant, 'Harbor Charters', 'displayName.charter.nav') + '</a>' +
    '<span style="margin-left:auto;font-size:13px;opacity:.5">' +
      wcSpan(tenant, 'wc.charter.secureCheckout', 'Secure checkout') + '</span>' +
    '</nav>';
}

function charterProductUnitPrice(prod) {
  var sale = Number(prod && prod.salePrice);
  var price = Number(prod && prod.price);
  if (sale > 0 && (!(price > 0) || sale <= price)) return sale;
  return price > 0 ? price : 0;
}

/** Checkout add-ons come from Shop products (active items on the tenant). */
function charterCheckoutAddons(tenant) {
  var list = (tenant && Array.isArray(tenant._products)) ? tenant._products : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (!p) continue;
    var name = String(p.name || '').trim();
    if (!name) continue;
    out.push({
      name: name,
      price: charterProductUnitPrice(p),
      productId: String(p.id || ''),
      imageUrl: String(p.imageUrl || '')
    });
  }
  return out;
}

function charterAddonPriceLabel(price) {
  var n = Number(price) || 0;
  if (n <= 0) return '+$0';
  if (typeof formatMoney === 'function') return '+' + formatMoney(n);
  return '+$' + (Math.round(n * 100) / 100);
}

function charterCheckoutPage(tenant, service, services) {
  var base = tenantBaseUrl(tenant);
  var s = service || (services && services[0]) || { name: 'Half-Day Reef Charter', price: 450, durationMinutes: 240 };
  var price = charterPriceLabel(s) || '$450';
  var priceNum = 0;
  if (typeof s.priceCents === 'number') priceNum = s.priceCents / 100;
  else if (typeof s.price === 'number') priceNum = s.price;
  else priceNum = 450;
  var perAngler = Math.round(priceNum / 2);
  var feats = (tenant.featuredWorkImages || tenant.galleryImages || []);
  var selectedServiceIndex = Math.max(0, (services || []).findIndex(function(candidate) {
    return candidate === s ||
      String(candidate.id || candidate.slug || '') === String(s.id || s.slug || '');
  }));
  var thumb = s.imageUrl || s.photoUrl ||
    (feats[selectedServiceIndex] && (feats[selectedServiceIndex].url || feats[selectedServiceIndex])) ||
    tenant.heroImageUrl || '';
  var addons = charterCheckoutAddons(tenant);
  var addonsHtml = addons.map(function(a, i) {
    var img = a.imageUrl
      ? '<img class="charter-addon-thumb" src="' + esc(a.imageUrl) + '" alt="">'
      : '';
    return charterKeyedCardBandHtml(tenant, 'charter.addon.' + (a.productId || String(i)), 'charter-blueprint charter-addon',
      '<input type="checkbox" data-charter-addon="' + i + '">' +
      img +
      '<span style="flex:1;font-size:14px">' + esc(a.name) + '</span>' +
      '<span style="font-size:13px;opacity:.7">' + esc(charterAddonPriceLabel(a.price)) + '</span>',
      ' data-addon-price="' + a.price + '" data-addon-name="' + esc(a.name) + '"' +
      (a.productId ? ' data-addon-product="' + esc(a.productId) + '"' : ''),
      'label');
  }).join('');
  var addonsBlock = addons.length
    ? ('<h4 style="margin:28px 0 12px">' + wcSpan(tenant, 'wc.charter.addonsHeading', 'Add-ons') + '</h4>' +
      '<div class="charter-addons">' + addonsHtml + '</div>')
    : '';
  var search = charterSearchQuery();
  var dateIso = search.date;
  var dateLabel = dateIso ? charterPrettyDateFromIso(dateIso) : 'Date on request';
  var people = search.people > 0 ? search.people : 2;
  var timeLabel = search.time && charterParseTimeToMin(search.time) != null
    ? charterFormatMin(charterParseTimeToMin(search.time))
    : '';
  var metaBits = [dateLabel];
  if (timeLabel) metaBits.push(timeLabel);
  metaBits.push(people + ' guests');
  var payMode = charterPayMode(tenant);
  var depositAmt = charterDepositAmount(tenant);
  var responseHours = Number(tenant && tenant.workflow && tenant.workflow.responseTimeHours);
  if (!isFinite(responseHours) || responseHours <= 0) responseHours = 24;
  responseHours = Math.max(1, Math.min(168, Math.round(responseHours)));
  var cta = payMode === 'full' ? 'Pay in full'
    : payMode === 'deposit' ? 'Pay deposit'
    : 'Request to book';
  var payNote = payMode === 'full'
    ? 'You’ll pay the trip total today to confirm your booking.'
    : payMode === 'deposit'
      ? (priceNum > 0
        ? 'Today you pay the deposit plus any add-ons to confirm your trip. The rest of the trip price is due before departure.'
        : 'Today you pay the deposit plus any add-ons to confirm your trip. The captain will confirm the trip price.')
      : 'You’ll hear back after the captain reviews this request. The boat is held for up to ' +
        responseHours + ' hours while they respond — no payment is taken now.';
  var dueLabel = payMode === 'request' ? 'Trip total' : 'Due today';
  var dueAmt = priceNum;
  var depositPart = 0;
  if (payMode === 'deposit') {
    var configuredDeposit = depositAmt > 0 ? depositAmt : Math.round(priceNum * 0.2 * 100) / 100;
    depositPart = priceNum > 0 ? Math.min(configuredDeposit, priceNum) : configuredDeposit;
    dueAmt = depositPart;
  }
  var charterDollars = function(n) {
    n = Number(n) || 0;
    return '$' + (Math.round(n * 100) % 100 === 0 ? String(Math.round(n)) : n.toFixed(2));
  };
  var tripPriceLabel = priceNum > 0 ? charterDollars(priceNum) : 'Price set by captain';
  return '<div class="charter-page">' +
    charterCheckoutNavHtml(tenant, s) +
    charterRouteCanvasOpen(tenant, 'charter.checkoutPage') +
    '<div class="charter-checkout">' +
      '<div class="charter-checkout-main">' +
        '<div class="charter-sec-label charter-sec-label--ink">' +
          wcSpan(tenant, 'wc.charter.checkoutStep', 'Step 1 of 2') + '</div>' +
        '<h2 class="charter-sec-heading" style="margin:0 0 20px">' +
          wcSpan(tenant, 'wc.charter.checkoutHeading', 'Trip details & contact') + '</h2>' +
        '<p class="charter-browse-empty" data-charter-checkout-error hidden></p>' +
        '<div class="charter-checkout-fields">' +
          '<div class="charter-field"><label>First name</label><input name="firstName" placeholder="Jamie" autocomplete="given-name"></div>' +
          '<div class="charter-field"><label>Last name</label><input name="lastName" placeholder="Rivera" autocomplete="family-name"></div>' +
          '<div class="charter-field charter-field--full"><label>Email</label><input name="email" type="email" placeholder="jamie@email.com" autocomplete="email"></div>' +
        '<div class="charter-field charter-field--full"><label>Mobile number</label><input name="phone" type="tel" placeholder="(305) 555-0148" autocomplete="tel" required></div>' +
        '<div class="charter-sms-consent charter-field--full">' +
          '<label class="charter-sms-consent-label">' +
            '<input name="smsConsent" type="checkbox">' +
            '<span>I agree to receive booking-related text messages at this number. Message and data rates may apply. Reply STOP to opt out.</span>' +
          '</label>' +
        '</div>' +
        '</div>' +
        addonsBlock +
        '<div class="charter-pay-box" data-charter-pay-box hidden>' +
          '<h4 style="margin:24px 0 10px">Card</h4>' +
          '<div id="bk-charter-payment-element"></div>' +
          '<p class="charter-browse-empty" data-charter-pay-loading hidden>Loading payment…</p>' +
        '</div>' +
        '<p style="margin:20px 0 0;font-size:13px;opacity:.7">' + esc(payNote) + '</p>' +
      '</div>' +
      '<div>' +
        charterKeyedCardBandHtml(tenant, 'charter.orderCard', 'charter-blueprint charter-order elev-md',
          '<div style="display:flex;gap:12px;margin-bottom:16px">' +
            (thumb
              ? '<img class="charter-order-thumb" src="' + esc(typeof thumb === 'string' ? thumb : '') + '" alt="">'
              : '<div class="charter-order-thumb charter-order-thumb--empty"></div>') +
            '<div><div class="charter-card-title" style="font-size:15px">' + esc(s.name || 'Charter') + '</div>' +
            '<div class="charter-meta">' + esc(metaBits.join(' · ')) + '</div></div>' +
          '</div>' +
          '<div class="charter-order-lines">' +
            '<div class="row"><span class="muted" data-line="anglers">Trip · ' + people + ' anglers</span><span data-line="tripTotal">' + esc(tripPriceLabel) + '</span></div>' +
            (addons.length ? '<div class="row"><span class="muted" data-line="addons-label">Add-ons</span><span data-line="addons">$0</span></div>' : '') +
            (priceNum > 0 && addons.length ? '<div class="row" data-line="trip-sum-row"><span>Trip total</span><span data-line="trip-sum">' + charterDollars(priceNum) + '</span></div>' : '') +
            '<div class="hr"></div>' +
            (payMode === 'deposit'
              ? '<div class="row"><span class="muted">Deposit</span><span data-line="deposit">' + charterDollars(depositPart) + '</span></div>' +
                (addons.length ? '<div class="row" data-line="due-addons-row" hidden><span class="muted">Add-ons</span><span data-line="due-addons">$0</span></div>' : '')
              : '') +
            '<div class="row total" data-line="due-row"><span data-line="due-label">' + esc(dueLabel) + '</span><span data-line="due">' + charterDollars(dueAmt) + '</span></div>' +
            (payMode === 'request' ? '' :
              '<div class="row" data-line="fee-row">' +
                '<span class="charter-fee-label">' +
                  '<span class="muted">Processing &amp; service fees</span>' +
                  '<span class="bk-shop-fee-info-wrap" id="bk-charter-fee-info-wrap">' +
                    '<button type="button" class="bk-shop-fee-info" id="bk-charter-fee-info" aria-label="Processing fee details" aria-expanded="false" aria-controls="bk-charter-fee-tip">i</button>' +
                    '<div class="bk-shop-fee-tip" id="bk-charter-fee-tip" role="tooltip"></div>' +
                  '</span>' +
                '</span>' +
                '<span data-line="fees" class="bk-shop-checkout-summary-fee-pending">Calculated at checkout</span>' +
              '</div>' +
              '<div class="row total" data-line="card-total-row" hidden><span>Charged on card</span><span data-line="card-total"></span></div>') +
            (payMode === 'deposit' && priceNum > 0
              ? '<div class="row" data-line="balance-row"><span class="muted">Balance due before departure</span><span data-line="balance">' + charterDollars(priceNum - depositPart) + '</span></div>'
              : '') +
          '</div>' +
          '<button type="button" class="charter-btn charter-btn-block" data-cta-key="wc.charter.checkoutConfirm" data-charter-confirm>' + esc(cta) + '</button>',
          ' data-base-price="' + priceNum + '" data-per-angler="' + perAngler + '"' +
          ' data-pay-mode="' + esc(payMode) + '" data-deposit="' + depositAmt + '"' +
          ' data-service-id="' + esc(s.id || '') + '" data-service-slug="' + esc(s.slug || '') + '"' +
          ' data-service-name="' + esc(s.name || '') + '" data-duration="' + (Number(s.durationMinutes) || 240) + '"') +
      '</div>' +
    '</div>' +
    '</div>' +
    charterFooterHtml(tenant) +
    '</div>';
}

function bindCharterCheckout(tenant, service) {
  var root = document.getElementById('root');
  if (!root) return;
  var order = root.querySelector('.charter-order');
  if (!order) return;
  var base = Number(order.getAttribute('data-base-price') || 0);
  var payMode = String(order.getAttribute('data-pay-mode') || charterPayMode(tenant) || 'request');
  var depositAmt = Number(order.getAttribute('data-deposit') || 0);
  var payBox = root.querySelector('[data-charter-pay-box]');
  var payLoading = root.querySelector('[data-charter-pay-loading]');
  var errEl = root.querySelector('[data-charter-checkout-error]');
  var btn = root.querySelector('[data-charter-confirm]');
  var charterPay = null;
  var feeLine = order.querySelector('[data-line="fees"]');
  var feeTip = document.getElementById('bk-charter-fee-tip');
  var feeInfoWrap = document.getElementById('bk-charter-fee-info-wrap');
  var feeInfoBtn = document.getElementById('bk-charter-fee-info');
  var dueRow = order.querySelector('[data-line="due-row"]');
  var cardRow = order.querySelector('[data-line="card-total-row"]');

  function charterMoney(cents) {
    var n = (Number(cents) || 0) / 100;
    return (typeof formatMoney === 'function') ? formatMoney(n) : ('$' + n.toFixed(2));
  }
  function setCharterFeePending(label) {
    if (!feeLine) return;
    feeLine.textContent = label || 'Calculated at checkout';
    feeLine.className = 'bk-shop-checkout-summary-fee-pending';
    if (feeTip && typeof shopCheckoutFeeTooltipHtml === 'function') {
      feeTip.innerHTML = shopCheckoutFeeTooltipHtml(null);
    }
    if (cardRow) cardRow.hidden = true;
    if (dueRow) dueRow.classList.add('total');
  }
  function bindCharterFeeTooltip() {
    if (!feeInfoBtn || !feeInfoWrap) return;
    if (feeTip && typeof shopCheckoutFeeTooltipHtml === 'function') {
      feeTip.innerHTML = shopCheckoutFeeTooltipHtml(null);
    }
    feeInfoBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var open = feeInfoWrap.classList.toggle('bk-shop-fee-tip-open');
      feeInfoBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function(e) {
      if (!feeInfoWrap.contains(e.target)) {
        feeInfoWrap.classList.remove('bk-shop-fee-tip-open');
        feeInfoBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }
  bindCharterFeeTooltip();

  function addonTotal() {
    var add = 0;
    var boxes = root.querySelectorAll('[data-charter-addon]');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked) {
        var lab = boxes[i].closest('[data-addon-price]');
        add += Number((lab && lab.getAttribute('data-addon-price')) || 0);
      }
    }
    return add;
  }
  function dollars(n) {
    n = Number(n) || 0;
    return '$' + (Math.round(n * 100) % 100 === 0 ? String(Math.round(n)) : n.toFixed(2));
  }
  function tripTotal() { return base + addonTotal(); }
  // Deposit mode: the deposit (never more than a priced trip) plus add-ons, paid today.
  // Matches createCharterCheckoutPayment on the server.
  function depositPart() {
    var configured = depositAmt > 0 ? depositAmt : Math.round(base * 0.2 * 100) / 100;
    return base > 0 ? Math.min(configured, base) : configured;
  }
  function dueNow() {
    if (payMode !== 'deposit') return tripTotal();
    return depositPart() + addonTotal();
  }
  function refresh() {
    var add = addonTotal();
    var set = function(key, text) {
      var el = order.querySelector('[data-line="' + key + '"]');
      if (el) el.textContent = text;
    };
    set('addons', dollars(add));
    set('trip-sum', dollars(tripTotal()));
    set('deposit', dollars(depositPart()));
    set('due-addons', dollars(add));
    var dueAddRow = order.querySelector('[data-line="due-addons-row"]');
    if (dueAddRow) dueAddRow.hidden = add <= 0;
    set('due', dollars(dueNow()));
    if (base > 0) set('balance', dollars(base - depositPart()));
    var picked = [];
    var checked = root.querySelectorAll('[data-charter-addon]:checked');
    for (var k = 0; k < checked.length; k++) {
      var lab = checked[k].closest('[data-addon-name]');
      var nm = lab ? String(lab.getAttribute('data-addon-name') || '').trim() : '';
      if (nm) picked.push(nm);
    }
    set('addons-label', picked.length ? 'Add-ons (' + picked.join(', ') + ')' : 'Add-ons');
    setCharterFeePending('Calculated at checkout');
    charterPay = null;
  }
  var boxes = root.querySelectorAll('[data-charter-addon]');
  for (var j = 0; j < boxes.length; j++) {
    boxes[j].addEventListener('change', refresh);
  }
  refresh();
  function showErr(msg) {
    if (!errEl) { window.alert(msg); return; }
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }
  if (!charterHasFleet(tenant)) {
    showErr(charterNoFleetMessage());
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.55';
    }
    return;
  }
  if (!btn) return;
  function confirmationUrl(totalCents) {
    var search = charterSearchQuery();
    var done = tenantBaseUrl(tenant).replace(/\/$/, '') + '/book/confirmed';
    var q = [];
    if (service && service.slug) q.push('trip=' + encodeURIComponent(service.slug));
    if (search.date) q.push('date=' + encodeURIComponent(search.date));
    if (search.time) q.push('time=' + encodeURIComponent(search.time));
    if (search.people) q.push('people=' + encodeURIComponent(search.people));
    q.push('mode=' + encodeURIComponent(payMode));
    if (totalCents != null && isFinite(Number(totalCents))) {
      q.push('paid=' + encodeURIComponent(String(Math.max(0, Math.round(Number(totalCents))))));
    }
    var balanceCents = charterPay && charterPay.balanceDueCents;
    if (balanceCents != null && isFinite(Number(balanceCents)) && Number(balanceCents) > 0) {
      q.push('balance=' + encodeURIComponent(String(Math.round(Number(balanceCents)))));
    }
    return q.length ? (done + '?' + q.join('&')) : done;
  }
  function goConfirmed() {
    window.location.href = confirmationUrl(charterPay && charterPay.totalCents);
  }
  function contact() {
    var first = (root.querySelector('input[name="firstName"]') || {}).value || '';
    var last = (root.querySelector('input[name="lastName"]') || {}).value || '';
    var email = (root.querySelector('input[name="email"]') || {}).value || '';
    var phone = (root.querySelector('input[name="phone"]') || {}).value || '';
    return { name: (first + ' ' + last).trim(), email: String(email).trim(), phone: String(phone).trim() };
  }
  function bookingPayload() {
    var c = contact();
    var search = charterSearchQuery();
    var preferredTime = search.time
      ? charterFormatMin(charterParseTimeToMin(search.time) || 0)
      : '';
    var notes = [];
    if (search.people) notes.push('Party of ' + search.people);
    var picked = [];
    var pickedProductIds = [];
    var addonBoxes = root.querySelectorAll('[data-charter-addon]');
    for (var ai = 0; ai < addonBoxes.length; ai++) {
      if (!addonBoxes[ai].checked) continue;
      var lab = addonBoxes[ai].closest('[data-addon-name]');
      var nm = lab ? String(lab.getAttribute('data-addon-name') || '').trim() : '';
      if (nm) picked.push(nm);
      var productId = lab ? String(lab.getAttribute('data-addon-product') || '').trim() : '';
      if (productId) pickedProductIds.push(productId);
    }
    if (picked.length) notes.push('Add-ons: ' + picked.join(', '));
    return {
      tenantSlug: tenant.slug,
      customerName: c.name,
      customerEmail: c.email,
      customerPhone: c.phone || null,
      smsConsentAccepted: !!(root.querySelector('input[name="smsConsent"]') || {}).checked,
      serviceId: order.getAttribute('data-service-id') || (service && service.id) || null,
      serviceSlug: order.getAttribute('data-service-slug') || (service && service.slug) || null,
      serviceName: order.getAttribute('data-service-name') || (service && service.name) || null,
      preferredTime: preferredTime || null,
      preferredDays: search.date ? [search.date] : null,
      scheduledDate: search.date || null,
      partySize: search.people || null,
      durationMinutes: parseInt(order.getAttribute('data-duration') || '0', 10) || (service && service.durationMinutes) || null,
      notes: notes.length ? notes.join('. ') : null,
      addonProductIds: pickedProductIds,
      boatId: search.boat || null
    };
  }
  function mountCharterPayment(data) {
    var pk = shopStripePublishableKey(data.publishableKey);
    if (!pk) throw new Error('Stripe publishable key is missing.');
    if (typeof Stripe !== 'function') throw new Error('Stripe.js did not load.');
    var stripe = Stripe(pk, checkoutStripeOptions(data.stripeAccountId));
    var elements = stripe.elements({
      clientSecret: data.clientSecret,
      appearance: shopPaymentElementAppearance(tenant)
    });
    var mountEl = document.getElementById('bk-charter-payment-element');
    if (!mountEl) throw new Error('Payment form is unavailable.');
    mountEl.innerHTML = '';
    var paymentElement = elements.create('payment', { layout: 'tabs' });
    paymentElement.mount('#bk-charter-payment-element');
    if (payBox) payBox.hidden = false;
    if (payLoading) payLoading.hidden = true;
    var cardTot = order.querySelector('[data-line="card-total"]');
    var addonLine = order.querySelector('[data-line="addons"]');
    var dueLine = order.querySelector('[data-line="due"]');
    if (feeLine && data.surchargeCents != null) {
      feeLine.textContent = charterMoney(data.surchargeCents);
      feeLine.className = '';
    }
    if (feeTip && typeof shopCheckoutFeeTooltipHtml === 'function') {
      feeTip.innerHTML = shopCheckoutFeeTooltipHtml({
        surchargeCents: data.surchargeCents || 0,
        platformFeeCents: data.platformFeeCents || 0
      });
    }
    if (cardRow) cardRow.hidden = false;
    if (dueRow) dueRow.classList.remove('total');
    if (cardTot && data.totalCents != null) cardTot.textContent = charterMoney(data.totalCents);
    if (addonLine && data.addonCents != null) addonLine.textContent = charterMoney(data.addonCents);
    if (dueLine && data.chargeCents != null) dueLine.textContent = charterMoney(data.chargeCents);
    var depositLine = order.querySelector('[data-line="deposit"]');
    if (depositLine && data.depositPartCents != null && data.payMode === 'deposit') {
      depositLine.textContent = charterMoney(data.depositPartCents);
    }
    var balanceLine = order.querySelector('[data-line="balance"]');
    if (balanceLine && data.balanceDueCents != null && data.tripCents > 0) {
      balanceLine.textContent = charterMoney(data.balanceDueCents);
    }
    charterPay = {
      stripe: stripe,
      elements: elements,
      requestId: data.requestId,
      paymentIntentId: data.paymentIntentId,
      totalCents: data.totalCents,
      surchargeCents: data.surchargeCents || 0,
      balanceDueCents: data.payMode === 'deposit' && data.tripCents > 0 ? data.balanceDueCents : null,
      rateLabel: '2.9% + 30¢',
      method: 'card'
    };
    var charterReprice = bindCheckoutMethodReprice({
      tenantSlug: tenant.slug,
      paymentIntentId: data.paymentIntentId,
      paymentElement: paymentElement,
      elements: elements,
      stripe: stripe,
      onPriced: function(priced) {
        if (!charterPay) return;
        charterPay.totalCents = priced.totalCents;
        charterPay.surchargeCents = priced.surchargeCents;
        charterPay.rateLabel = priced.rateLabel || '';
        charterPay.method = priced.method || 'card';
        if (feeLine && priced.surchargeCents != null) {
          feeLine.textContent = charterMoney(priced.surchargeCents);
          feeLine.className = '';
        }
        if (feeTip) feeTip.innerHTML = shopCheckoutFeeTooltipHtml(charterPay);
        if (cardTot && priced.totalCents != null) cardTot.textContent = charterMoney(priced.totalCents);
      },
      onError: function(err) { showErr(formatFirebaseHttpsError(err)); },
      onNotice: function(msg) { if (msg || errEl) showErr(msg || ''); }
    });
    charterPay.prepareConfirm = charterReprice.prepareConfirm;
    btn.textContent = payMode === 'deposit' ? 'Pay deposit' : 'Pay now';
  }

  btn.addEventListener('click', function() {
    showErr('');
    var c = contact();
    if (!c.name || !c.email || !c.phone) {
      showErr('Enter your name, email, and mobile number to continue.');
      return;
    }
    if (!(root.querySelector('input[name="smsConsent"]') || {}).checked) {
      showErr('Agree to receive booking-related text messages to continue.');
      return;
    }
    if (payMode === 'request') {
      btn.disabled = true;
      var orig = btn.textContent;
      btn.textContent = 'Sending…';
      functions.httpsCallable('createBookingRequestFromWeb')(bookingPayload())
        .then(goConfirmed)
        .catch(function(e) {
          btn.disabled = false;
          btn.textContent = orig;
          showErr(formatFirebaseHttpsError(e));
        });
      return;
    }
    if (charterPay && charterPay.stripe && charterPay.elements) {
      btn.disabled = true;
      btn.textContent = 'Paying…';
      confirmCheckoutPayment(
        charterPay.prepareConfirm,
        charterPay.stripe,
        charterPay.elements,
        { return_url: confirmationUrl(null) }
      ).then(function(result) {
        if (result.error) throw result.error;
        return ensureAnonymousAuth().then(function() {
          return functions.httpsCallable('finalizeCharterBookingPayment')({
            tenantSlug: tenant.slug,
            requestId: charterPay.requestId,
            paymentIntentId: charterPay.paymentIntentId
          });
        });
      }).then(goConfirmed).catch(function(e) {
        btn.disabled = false;
        btn.textContent = payMode === 'deposit' ? 'Pay deposit' : 'Pay now';
        showErr((e && e.message) ? e.message : formatFirebaseHttpsError(e));
      });
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Loading payment…';
    setCharterFeePending('Calculating…');
    if (payBox) payBox.hidden = false;
    if (payLoading) payLoading.hidden = false;
    var stripeReady = (window.BKSitePerf && window.BKSitePerf.ensureStripe)
      ? window.BKSitePerf.ensureStripe()
      : Promise.resolve();
    ensureAnonymousAuth()
      .then(function() { return stripeReady; })
      .then(function() {
        return functions.httpsCallable('createCharterCheckoutPayment')(bookingPayload());
      })
      .then(function(res) {
        var data = (res && res.data) || {};
        if (!data.clientSecret || !data.stripeAccountId) {
          throw new Error('Could not start payment. Connect Stripe in Payment settings.');
        }
        mountCharterPayment(data);
        btn.disabled = false;
      })
      .catch(function(e) {
        btn.disabled = false;
        btn.textContent = payMode === 'deposit' ? 'Pay deposit' : 'Pay in full';
        if (payLoading) payLoading.hidden = true;
        if (!charterPay) setCharterFeePending('Calculated at checkout');
        showErr(formatFirebaseHttpsError(e));
      });
  });
}

function charterConfirmationPage(tenant, service) {
  var base = tenantBaseUrl(tenant);
  var s = service || { name: 'Half-Day Reef Charter' };
  var search = charterSearchQuery();
  var params;
  try { params = new URLSearchParams(location.search || ''); } catch (_) { params = null; }
  var mode = params ? String(params.get('mode') || '').toLowerCase() : '';
  var paidCents = params ? parseInt(params.get('paid') || '', 10) : NaN;
  var isRequest = mode === 'request';
  var title = isRequest ? 'Request sent' : 'Trip booked';
  var subtitle = isRequest
    ? 'The captain will review your request and contact you soon.'
    : 'Your payment was completed and your trip is confirmed.';
  var dateText = search.date ? charterPrettyDateFromIso(search.date) : '—';
  var startMin = charterParseTimeToMin(search.time);
  var timeText = startMin == null ? '—' : charterFormatMin(startMin);
  var guestsText = search.people > 0
    ? search.people + (search.people === 1 ? ' angler' : ' anglers')
    : '—';
  var meeting = webCopyOverrideText(tenant, 'wc.charter.meetingPoint', 'Garrison Bight Marina');
  var balanceCents = params ? parseInt(params.get('balance') || '', 10) : NaN;
  var paidRow = !isRequest && isFinite(paidCents)
    ? '<div class="hr"></div><div class="row total"><span>Paid today</span><span>$' +
      (paidCents / 100).toFixed(2) + '</span></div>' +
      (isFinite(balanceCents) && balanceCents > 0
        ? '<div class="row"><span class="muted">Balance due before departure</span><span>$' +
          (balanceCents / 100).toFixed(2) + '</span></div>'
        : '')
    : '';
  var smsPhone = (tenant.smsPhoneNumber || '').toString().trim();
  var contactPhone = (tenant.contactPhone || '').toString().trim();
  var captainPhone = (tenantClientSmsActive(tenant) && smsPhone) ? smsPhone : contactPhone;
  var captainTel = telHrefFromPhone(captainPhone);
  var captainLabel = displayPhoneUS(captainPhone) || captainPhone;
  var captainNote = '';
  if (!isRequest && captainPhone) {
    var phoneHtml = captainTel
      ? '<a href="' + esc(captainTel) + '">' + esc(captainLabel) + '</a>'
      : esc(captainLabel);
    captainNote = '<p class="charter-confirm-note">To reschedule or cancel your trip, please reach out to your captain at ' +
      phoneHtml + '.</p>';
  }
  return '<div class="charter-page" style="display:flex;flex-direction:column;min-height:100vh">' +
    charterNavHtml(tenant, 'book') +
    '<div class="charter-confirm"' + charterBandAttrs(tenant, 'page', 'charter.confirmPage') + '>' +
      '<div class="charter-blueprint charter-confirm-check">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="34" height="34"><path d="M20 6L9 17l-5-5"></path></svg>' +
      '</div>' +
      '<div><h2 style="margin:0 0 6px">' + esc(title) + '</h2>' +
      '<p style="margin:0;font-size:14px;opacity:.7">' + esc(subtitle) + '</p></div>' +
      charterKeyedCardBandHtml(tenant, 'charter.confirmCard', 'charter-blueprint charter-confirm-card elev-sm',
        '<div class="charter-card-title" style="margin-bottom:10px">' + esc(s.name || 'Charter') + '</div>' +
        '<div class="charter-confirm-rows">' +
          '<div class="row"><span class="muted">Date</span><span>' + esc(dateText) + '</span></div>' +
          '<div class="row"><span class="muted">Departure</span><span>' + esc(timeText) + '</span></div>' +
          '<div class="row"><span class="muted">Guests</span><span>' + esc(guestsText) + '</span></div>' +
          '<div class="row"><span class="muted">Meeting point</span><span data-edit-key="wc.charter.meetingPoint">' + esc(meeting) + '</span></div>' +
          paidRow +
        '</div>') +
      captainNote +
      '<div class="charter-confirm-actions">' +
        '<a class="charter-btn" href="' + base + '/charters" data-cta-key="wc.charter.browseMore">' +
          wcSpan(tenant, 'wc.charter.browseMore', 'Browse more charters') + '</a>' +
      '</div>' +
    '</div>' +
    charterFooterHtml(tenant) +
    '</div>';
}

function charterShopCheckoutPage(tenant) {
  return '<div class="charter-page">' +
    charterNavHtml(tenant, 'shop') +
    '<div class="charter-shop-checkout-shell"' + charterBandAttrs(tenant, 'page', 'charter.shopCheckout') + '>' +
      shopCheckoutInnerHtml(tenant) +
    '</div>' +
    charterFooterHtml(tenant) +
    '</div>';
}
