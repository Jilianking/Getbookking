/* Stonecut template. */

/** Stonecut keyed cards (services, hours, where, booking form): readable ink on custom fills. */
function isStonecutKeyedCardKey(key) {
  if (!key) return false;
  if (key.indexOf('stonecut.svcCard.') === 0) return true;
  return key === 'stonecut.when' || key === 'stonecut.where' || key === 'stonecut.bookingCard';
}

function applyKeyedStonecutSvcCardInk(el, key, bgCol) {
  if (!el || !bgCol || bgCol.charAt(0) !== '#') return;
  if (!isStonecutKeyedCardKey(key)) return;
  var fg = contrastingInkHex(bgCol);
  try { el.style.setProperty('color', fg, 'important'); }
  catch (e) { el.style.color = fg; }
  el.style.setProperty('--bk-fg', fg);
  el.style.setProperty('--bk-fg-muted', rgbaFromHex(fg, 0.58));
  el.style.setProperty('--bk-accent', fg);
}

function clearKeyedStonecutSvcCardInk(el, key) {
  if (!el || !isStonecutKeyedCardKey(key)) return;
  el.style.removeProperty('color');
  el.style.removeProperty('--bk-fg');
  el.style.removeProperty('--bk-fg-muted');
  el.style.removeProperty('--bk-accent');
}

/** Stonecut: empty hero slots + unkeyed footer follow palette tokens. */
function applyStonecutHomeBandColors(tenant) {
  if (!isStonecutTheme(tenant)) return;
  var c = tenantColors(tenant);
  applyEmptyImageSlotColors(tenant);
  var lineColor = rgbaFromHex(c.fg, 0.08);
  [].forEach.call(document.querySelectorAll('.stonecut-page footer'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.aboutBg;
    el.style.color = c.aboutFg;
    el.style.borderTopColor = lineColor;
  });
}

/** Paint Stonecut /book root + shell so `stonecut.bookingPage` stays visible (nav stays `stonecut.nav`). */
function applyStonecutBookingPageRootFill(col) {
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
  [].forEach.call(document.querySelectorAll('.stonecut-page:has(.booking-shell)'), function(root) {
    paint(root);
    [].forEach.call(root.querySelectorAll('.booking-shell'), paint);
    [].forEach.call(root.querySelectorAll('.booking-page-band'), paint);
  });
}

/** Stonecut-only per-band paint key (`webSurfaceColors`). */
function stonecutBkSurfaceKeyAttr(tenant, key) {
  if (!tenant || !key) return '';
  if (!isStonecutTheme(tenant)) return '';
  return ' data-bk-surface-key="' + esc(key) + '"';
}

/** Stonecut card/block paint target — role `card` plus a unique key so fills never share tokens. */
function stonecutBkCardSurfaceAttrs(tenant, key) {
  if (!tenant || !key || !isStonecutTheme(tenant)) return '';
  return ' data-bk-color-surface="card"' + stonecutBkSurfaceKeyAttr(tenant, key);
}

/** Stonecut location/service card — Blade-style band (hit target + content) per keyed fill. */
function stonecutInfoCardBandHtml(tenant, surfaceKey, innerHtml) {
  if (!tenant || !surfaceKey || !isStonecutTheme(tenant)) {
    return '<div class="stonecut-info-card bk-fade-up">' + innerHtml + '</div>';
  }
  return '<div class="stonecut-info-card bk-fade-up" data-bk-color-surface="card"' +
    stonecutBkSurfaceKeyAttr(tenant, surfaceKey) + ' data-bk-band-tappable>' +
    bkColorBandHitButtonHtml() +
    '<div class="bk-band-content">' + innerHtml + '</div></div>';
}

function isStonecutTheme(tenant) {
  return tenant && tenant.resolvedWebThemeId === 'stonecut-v1';
}

/** Stonecut fixed nav: scroll collapse + sync page padding to nav height. */
function bindStonecutNavChrome() {
  var nav = document.getElementById('stonecut-nav');
  if (!nav) return;
  function syncNavOffset() {
    var activeNav = document.getElementById('stonecut-nav');
    if (!activeNav) return;
    var activePage = activeNav.closest('.stonecut-page');
    if (activePage) activePage.style.setProperty('--stonecut-nav-h', activeNav.offsetHeight + 'px');
  }
  function onScScroll() {
    var activeNav = document.getElementById('stonecut-nav');
    if (!activeNav) return;
    activeNav.classList.toggle('scrolled', window.scrollY > 60);
    syncNavOffset();
  }
  onScScroll();
  if (!window.__stonecutNavScrollBound) {
    window.__stonecutNavScrollBound = true;
    window.addEventListener('scroll', onScScroll, { passive: true });
    window.addEventListener('resize', syncNavOffset, { passive: true });
  }
  if (document.fonts && document.fonts.ready && !nav.__bkFontsSynced) {
    nav.__bkFontsSynced = true;
    document.fonts.ready.then(syncNavOffset);
  }
  if (typeof ResizeObserver !== 'undefined' && !nav.__bkResizeObserved) {
    nav.__bkResizeObserved = true;
    var ro = new ResizeObserver(syncNavOffset);
    ro.observe(nav);
  }
}

/** Stonecut hero `<em>` line — industry name; city / area stays in `.stonecut-tag` only. */
function stonecutIndustryDisplayName(tenant) {
  var custom = tenant && tenant.industryCustomLabel && String(tenant.industryCustomLabel).trim();
  if (custom) return custom;
  var k = String((tenant && tenant.industry) || '').trim().toLowerCase();
  var map = {
    barber: 'Barber',
    hair: 'Hair salon',
    tattoos: 'Tattoo studio',
    nails: 'Nail studio',
    charters: 'Charter',
    custom: 'Studio'
  };
  return map[k] || map.custom;
}

/**
 * Editable Stonecut industry line (`wc.stonecut.heroIndustry`).
 * Missing override → industry default; explicit "" → hide; any other text → custom.
 */
function stonecutIndustryLineText(tenant) {
  var key = 'wc.stonecut.heroIndustry';
  var m = tenant && tenant.webCopyOverrides;
  if (m && typeof m === 'object' && Object.prototype.hasOwnProperty.call(m, key)) {
    var v = m[key];
    return v != null ? String(v).trim() : '';
  }
  return stonecutIndustryDisplayName(tenant);
}

/** `<em>` + quick-edit span for hero/nav. Empty line is omitted visually (placeholder in Manage). */
function stonecutIndustryEmHtml(tenant, emClass) {
  var key = 'wc.stonecut.heroIndustry';
  var text = stonecutIndustryLineText(tenant);
  var classes = ['stonecut-industry-line'];
  if (emClass) classes.push(String(emClass));
  if (!text) classes.push('stonecut-industry-line--empty');
  return '<em class="' + esc(classes.join(' ')) + '">' +
    '<span data-edit-key="' + esc(key) + '">' + esc(text) + '</span></em>';
}

/** Stonecut top bar (fixed); same markup on home, shop, /book, and post-submit. */
function stonecutNavHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var sa = tenant.serviceArea && String(tenant.serviceArea).trim() ? String(tenant.serviceArea).trim() : '';
  var locationHtml = sa
    ? ('<span class="stonecut-nav-location">' + wcSpan(tenant, 'wc.contact.serviceArea', sa) + '</span>')
    : '';
  return '<nav class="stonecut-nav" id="stonecut-nav" data-bk-color-surface="page"' +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.nav') + '>' +
    '<a href="' + base + '/home" class="stonecut-logo">' +
    '<span class="stonecut-logo-wordmark">' + siteNameSpan(tenant, 'Studio', 'displayName.stonecut.nav') + '</span>' +
    '<span class="stonecut-logo-stack">' +
    stonecutIndustryEmHtml(tenant, 'stonecut-nav-industry') +
    '<span class="stonecut-nav-name">' + siteNameSpan(tenant, 'Studio', 'displayName.stonecut.nav') + '</span>' +
    locationHtml +
    '</span></a>' +
    '<div class="stonecut-nav-trailing">' +
    '<ul class="stonecut-links">' +
    '<li><a href="' + base + '/home#services">Services</a></li>' +
    (tenantShowGalleryPage(tenant) ? '<li><a href="' + galleryUrl + '">Portfolio</a></li>' : '') +
    (tenantShowTeamPage(tenant) ? '<li><a href="' + base + '/team">Team</a></li>' : '') +
    (tenantShowAboutPage(tenant) ? '<li><a href="' + base + '/about">About</a></li>' : '') +
    (tenantShowShopPage(tenant) ? '<li><a href="' + base + '/shop">Shop</a></li>' : '') +
    (tenantShowBookPage(tenant) ? '<li><a href="' + bookUrl + '" data-cta-key="wc.stonecut.navBook">' + wcSpan(tenant, 'wc.stonecut.navBook', 'Book') + '</a></li>' : '') + '</ul>' +
    '<button class="tattoo-nav-menu" type="button" aria-label="Menu">' + hamburgerMenuSvg() + '</button>' +
    '</div></nav>';
}

function stonecutHomePage(tenant, services) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var displayName = tenantSiteDisplayName(tenant, 'Studio');
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
  var svc = services || [];
  var serviceCards = '';
  for (var i = 0; i < svc.length; i++) {
    var s = svc[i] || {};
    var href = base + '/book/' + (s.slug || '');
    var desc = (s.description && String(s.description).trim()) ? String(s.description).trim() : 'Custom work designed for your placement and style.';
    var priceTxt = (typeof s.price === 'number' && s.price > 0) ? ('From $' + Number(s.price).toFixed(0)) : 'Book for pricing';
    var sidSc = s.id ? String(s.id) : '';
    var svcCardKey = sidSc ? ('stonecut.svcCard.' + sidSc) : ('stonecut.svcCard.i' + i);
    var cardSurfaceAttrs = stonecutBkCardSurfaceAttrs(tenant, svcCardKey);
    var cardInner = '<h3>' + svcSpan(tenant, sidSc, 'name', s.name || 'Service') + '</h3><p>' + svcSpanMultiline(tenant, sidSc, 'description', desc) + '</p><div class="stonecut-price">' + svcSpan(tenant, sidSc, 'price', priceTxt) + '</div>';
    if (tenantShowBookPage(tenant)) {
      serviceCards += '<a href="' + esc(href) + '" class="stonecut-service-card bk-fade-up"' + cardSurfaceAttrs + svcEditAttr(sidSc) + '>' + cardInner + '</a>';
    } else {
      serviceCards += '<div class="stonecut-service-card bk-fade-up"' + cardSurfaceAttrs + svcEditAttr(sidSc) + '>' + cardInner + '</div>';
    }
  }
  if (!serviceCards) {
    serviceCards = '<div class="stonecut-service-card bk-fade-up"' + stonecutBkCardSurfaceAttrs(tenant, 'stonecut.svcCard.empty') + '><h3>Add services</h3><p>Add active services in the app to populate this section.</p><div class="stonecut-price">Setup needed</div></div>';
  }
  var addrRaw = tenantStreetAddressText(tenant);
  var sa = tenant.serviceArea && String(tenant.serviceArea).trim() ? String(tenant.serviceArea).trim() : '';
  var whereHeadline = sa || (addrRaw ? addrRaw.split('\n')[0] : 'Location');
  var mapQuery = addrRaw ? googleMapsSearchUrl(addrRaw) : (sa ? googleMapsSearchUrl(sa) : '');
  var addrBodyPlainSc = addrRaw || sa || 'Add your address in the app.';
  var addrBodyWrappedSc = wcSpanMultiline(tenant, 'wc.contact.location', addrBodyPlainSc);
  var phoneHref = telHrefFromPhone(tenant.contactPhone);
  var tagTrim = tenant.tagline && String(tenant.tagline).trim() ? String(tenant.tagline).trim() : '';
  var taglineHtml = tagTrim
    ? ('<div class="stonecut-tag">' + wcSpan(tenant, 'wc.stonecut.heroTagline', tagTrim) + '</div>')
    : '';
  var cityTagHtml = sa ? ('<div class="stonecut-tag">' + wcSpan(tenant, 'wc.contact.serviceArea', sa) + '</div>') : '';
  var heroCtaInner = tenantShowBookPage(tenant)
    ? '<a href="' + bookUrl + '" class="stonecut-btn stonecut-btn-primary" data-cta-key="wc.stonecut.heroBook">' + wcSpan(tenant, 'wc.stonecut.heroBook', 'Book a session') + '</a>'
    : '';
  var heroCta = heroCtaInner ? ('<div class="stonecut-hero-cta">' + heroCtaInner + '</div>') : '';
  var shopPreviewSection = (function(){
    if (!tenantShowShopPage(tenant) || !tenant._products || !tenant._products.length) return '';
    var cards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'stonecut.homeProduct.' });
    if (!cards) return '';
    return '<section class="stonecut-section stonecut-shop-preview" id="shop" data-bk-color-surface="card"' +
      stonecutBkSurfaceKeyAttr(tenant, 'stonecut.shop') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="stonecut-eyebrow bk-fade-up">' + wcSpan(tenant, 'wc.stonecut.shopEyebrow', 'Retail') + '</div>' +
      '<h2 class="stonecut-heading bk-fade-up">' + wcSpan(tenant, 'wc.stonecut.shopHeading', 'Shop') + '</h2>' +
      '<p class="stonecut-shop-lead bk-fade-up">' + wcSpan(tenant, 'wc.stonecut.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p>' +
      '<div class="stonecut-shop-grid bk-fade-up">' + cards + '</div>' +
      '<a href="' + base + '/shop" class="stonecut-btn stonecut-btn-primary" data-cta-key="wc.stonecut.shopFull" style="margin-top:28px;display:inline-block">' + wcSpan(tenant, 'wc.stonecut.shopFull', 'Full shop') + '</a>') +
      '</section>';
  })();
  var aboutSection = (function() {
    if (!tenantShowAboutPage(tenant)) return '';
    var aboutBioPlain = ((tenant.aboutText && String(tenant.aboutText).trim()) || (tenant.tagline && String(tenant.tagline).trim()) || 'Tell clients about your shop and what makes your chair different.');
    var aboutBody = wcSpanMultiline(tenant, 'wc.stonecut.aboutBio', aboutBioPlain);
    return '<section class="stonecut-section stonecut-about-section" id="about" data-bk-color-surface="card"' +
      stonecutBkSurfaceKeyAttr(tenant, 'stonecut.about') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="stonecut-about-inner">' +
      '<div class="stonecut-about-copy bk-fade-up">' +
      '<div class="stonecut-eyebrow">' + wcSpan(tenant, 'wc.stonecut.aboutEyebrow', 'About') + '</div>' +
      '<h2 class="stonecut-heading">' + wcSpan(tenant, 'wc.stonecut.aboutTitle', displayName) + '</h2>' +
      '<p class="stonecut-about-bio">' + aboutBody + '</p>' +
      '</div>' +
      '<div class="stonecut-about-media bk-fade-up">' + stonecutAboutPhotoHtml(tenant) + '</div>' +
      '</div>') + '</section>';
  })();
  return '<div class="stonecut-page">' +
    stonecutNavHtml(tenant) +
    '<section class="stonecut-hero" data-bk-color-surface="hero"' +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.hero') + '>' +
    bkHeroBandHitButtonHtml() +
    '<div class="stonecut-hero-left bk-fade-up" data-bk-hero-band-tappable>' +
    '<h1 class="stonecut-title">' + stonecutIndustryEmHtml(tenant, '') + siteNameSpan(tenant, 'Studio', 'displayName.stonecut.hero') + '</h1>' +
    taglineHtml +
    cityTagHtml +
    heroCta +
    '</div><div class="stonecut-hero-right">' + (tenant.heroImageUrl
      ? '<img class="stonecut-hero-photo" data-edit-key="heroImage" src="' + esc(tenant.heroImageUrl) + '" alt="">'
      : '<div class="stonecut-hero-photo stonecut-hero-photo--empty" data-edit-key="heroImage" role="button" aria-label="Add hero image"></div>') +
      bkHeroImageHitButtonHtml() + '</div></section>' +
    '<section class="stonecut-section" id="services" data-bk-color-surface="page"' +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.services') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="stonecut-eyebrow bk-fade-up">' + wcSpan(tenant, 'wc.stonecut.servicesEyebrow', 'What we offer') + '</div><h2 class="stonecut-heading bk-fade-up">' + wcSpan(tenant, 'wc.stonecut.servicesTitle', 'Services') + '</h2>' +
    '<div class="stonecut-services">' + serviceCards + '</div>') + '</section>' +
    shopPreviewSection +
    aboutSection +
    '<section class="stonecut-section" id="location" data-bk-color-surface="about"' +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.location') + ' data-bk-band-tappable>' + bkColorBandInnerWrap((function() {
      var whenInner = '<div class="stonecut-eyebrow">When</div><h3>Hours</h3>' +
        (tenantBusinessHoursTrimmed(tenant)
          ? '<div class="stonecut-info-hours-body">' + wcSpanMultiline(tenant, 'wc.contact.hours', tenantBusinessHoursTrimmed(tenant)) + '</div>'
          : '<div class="stonecut-info-hours-body">' + wcSpan(tenant, 'wc.contact.hours', 'Add hours in the app.') + '</div>');
      var whereInner = '<div class="stonecut-eyebrow">Where</div><h3>' + wcSpan(tenant, 'wc.contact.whereHead', whereHeadline) + '</h3>' +
        (mapQuery ? '<a href="' + esc(mapQuery) + '" class="stonecut-address-link" target="_blank" rel="noopener noreferrer">' + addrBodyWrappedSc + '</a>' : '<div class="stonecut-address-link">' + addrBodyWrappedSc + '</div>') +
        (phoneHref ? '<a href="' + esc(phoneHref) + '" class="stonecut-phone">' + wcSpan(tenant, 'wc.contact.phone', tenant.contactPhone ? displayPhoneUS(tenant.contactPhone) : '') + '</a>' : '');
      return '<div class="stonecut-info' + (!tenantShowBusinessHours(tenant) ? ' stonecut-info--no-hours' : '') + '">' +
        (tenantShowBusinessHours(tenant) ? stonecutInfoCardBandHtml(tenant, 'stonecut.when', whenInner) : '') +
        stonecutInfoCardBandHtml(tenant, 'stonecut.where', whereInner) +
        '</div>';
    })()) + '</section>' +
    teamHomeSectionHtml(tenant) +
    stonecutSiteFooterHtml(tenant) +
    sidebar +
    '</div>';
}

/** Stonecut about column: featuredWork slot 0 only (not gallery / hero). */
function stonecutAboutPhotoMeta(tenant) {
  var featured = featuredStripSlotUrl(featuredUrlsForHomeStrip(tenant, 1), 0);
  if (featured) return { url: featured, editKey: 'featuredWork:0' };
  return { url: '', editKey: 'featuredWork:0' };
}

function stonecutAboutPhotoHtml(tenant) {
  var meta = stonecutAboutPhotoMeta(tenant);
  if (meta.url) {
    return '<img class="stonecut-about-photo" data-edit-key="' + esc(meta.editKey) + '" src="' + esc(meta.url) + '" alt="">';
  }
  return '<div class="stonecut-about-photo stonecut-about-photo--empty" data-edit-key="' + esc(meta.editKey) + '" role="button" aria-label="Add about photo"></div>';
}

/** Stonecut footer: optional Instagram link + © line. */
function stonecutSiteFooterHtml(tenant) {
  var custom = customSiteFooterHtml(tenant, {
    attrs: ' data-bk-color-surface="about"' + stonecutBkSurfaceKeyAttr(tenant, 'stonecut.footer') + ' data-bk-band-tappable'
  });
  if (custom) return custom;
  var ig = tenant.instagramHandle ? String(tenant.instagramHandle).replace(/^@/, '') : '';
  var igUrl = ig ? ('https://instagram.com/' + encodeURIComponent(ig)) : '';
  var linksHtml = igUrl
    ? ('<div class="stonecut-footer-links"><a href="' + esc(igUrl) + '" target="_blank" rel="noopener noreferrer">' +
      wcSpan(tenant, 'wc.stonecut.footerInstagram', 'Instagram') + '</a></div>')
    : '';
  return '<footer data-bk-color-surface="about"' +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.footer') + ' data-bk-band-tappable>' +
    linksHtml + footerLegalLineHtml(tenant) + '</footer>';
}

function stonecutShopPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
  var nav = stonecutNavHtml(tenant);
  var productCards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'stonecut.shopProduct.' });
  var mainInner = productCards
    ? '<div class="stonecut-eyebrow">' + wcSpan(tenant, 'wc.stonecut.shopEyebrow', 'Retail') + '</div><h2 class="stonecut-heading">' + wcSpan(tenant, 'wc.stonecut.shopHeading', 'Shop') + '</h2><p class="stonecut-shop-lead">' + wcSpan(tenant, 'wc.stonecut.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><div class="stonecut-shop-grid">' + productCards + '</div>'
    : '<div class="stonecut-eyebrow">' + wcSpan(tenant, 'wc.stonecut.shopEyebrow', 'Retail') + '</div><h2 class="stonecut-heading">' + wcSpan(tenant, 'wc.stonecut.shopHeading', 'Shop') + '</h2><p class="stonecut-shop-lead">' + wcSpan(tenant, 'wc.stonecut.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><p class="stonecut-shop-empty">No products yet. Check back soon.</p>';
  var main = '<main class="stonecut-shop-shell" data-bk-color-surface="page"' +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.shopPage') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap(mainInner) + '</main>';
  return '<div class="stonecut-page">' + nav + main + stonecutSiteFooterHtml(tenant) + sidebar + '</div>';
}

function stonecutShopCheckoutPage(tenant) {
  var main = '<main class="stonecut-shop-shell stonecut-checkout-shell">' + shopCheckoutInnerHtml(tenant) + '</main>';
  return '<div class="stonecut-page">' + stonecutNavHtml(tenant) + main + stonecutSiteFooterHtml(tenant) + tattooSidebarShellHtml(tenant) + '</div>';
}
