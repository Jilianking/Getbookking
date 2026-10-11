/* Luxe template. */

/** Luxe home: unkeyed bands follow palette; keyed spots (`luxe.*`) stay in `webSurfaceColors`. */
function applyLuxeHomeBandColors(tenant) {
  if (!isLuxeTheme(tenant)) return;
  var c = tenantColors(tenant);
  function skipKeyed(el) {
    return !!(el.getAttribute('data-bk-surface-key') || '').trim();
  }
  [].forEach.call(document.querySelectorAll('.luxe-promo'), function(el) {
    if (skipKeyed(el)) return;
    el.style.background = c.card;
  });
  /* Home About (`luxe.about`) uses role `card` — not restamped here (see applyColorSurfaceBands). */
  [].forEach.call(document.querySelectorAll('.luxe-contact'), function(el) {
    if (skipKeyed(el)) return;
    el.style.background = c.aboutBg;
    el.style.color = c.aboutFg;
    el.style.setProperty('--bk-about-bg', c.aboutBg);
    el.style.setProperty('--bk-about-fg', c.aboutFg);
  });
  [].forEach.call(document.querySelectorAll('.luxe-footer-legal'), function(el) {
    if (skipKeyed(el)) return;
    el.style.background = c.aboutBg;
    el.style.setProperty('--bk-about-bg', c.aboutBg);
  });
}

/** Paint Luxe /book root + shell so `luxe.bookingPage` stays visible even if theme CSS is stale/opaque. */
function applyLuxeBookingPageRootFill(col) {
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
  [].forEach.call(document.querySelectorAll('.luxe-page:has(.booking-shell)'), function(root) {
    paint(root);
    [].forEach.call(root.querySelectorAll('.booking-shell'), paint);
    [].forEach.call(root.querySelectorAll('.booking-page-band'), paint);
  });
}

/** Luxe-only per-band paint key (`webSurfaceColors`). */
function luxeBkSurfaceKeyAttr(tenant, key) {
  if (!tenant || !key) return '';
  if (!isLuxeTheme(tenant)) return '';
  return ' data-bk-surface-key="' + esc(key) + '"';
}

function isLuxeTheme(tenant) {
  return tenant && tenant.resolvedWebThemeId === 'luxe-v1';
}

/** Luxe top bar: `hero` = cream strip + dark links above hero; `light` = same palette on subpages (absolute over shell). */
function luxeChromeNavHtml(tenant, variant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var displayName = tenantSiteDisplayName(tenant, 'Welcome');
  var navClass = variant === 'light'
    ? 'luxe-nav luxe-nav--light'
    : 'luxe-nav luxe-nav--light luxe-nav--topbar';
  var inner = '<a href="' + base + '/home">Home</a>';
  if (tenantShowGalleryPage(tenant)) inner += '<a href="' + galleryUrl + '">Gallery</a>';
  if (tenantShowTeamPage(tenant)) inner += '<a href="' + base + '/team">Team</a>';
  if (tenantShowShopPage(tenant)) inner += '<a href="' + base + '/shop">Shop</a>';
  if (tenantShowAboutPage(tenant)) inner += '<a href="' + base + '/about">About</a>';
  if (tenantShowBookPage(tenant)) inner += '<a href="' + bookUrl + '" class="luxe-nav-book" data-cta-key="wc.luxe.navBook">' + wcSpan(tenant, 'wc.luxe.navBook', 'Booking') + '</a>';
  return '<nav class="' + navClass + '" data-bk-color-surface="page"' + luxeBkSurfaceKeyAttr(tenant, 'luxe.nav') + '>' +
    '<a href="' + base + '/home" class="luxe-nav-brand">' + siteNameSpan(tenant, 'Welcome', 'displayName.luxe.nav') + '</a>' +
    '<div class="luxe-nav-trailing">' +
      '<div class="luxe-nav-links">' + inner + '</div>' +
    '<button class="tattoo-nav-menu" type="button" aria-label="Menu" style="background:none;border:none;font-size:1.5rem;cursor:pointer;padding:8px;display:none">' + hamburgerMenuSvg() + '</button>' +
    '</div>' +
  '</nav>';
}

/** Luxe: contact strip + © legal line — separate paint cards (`luxe.contact` ≠ `luxe.legal`). */
function luxeContactSectionHtml(tenant) {
  var y = new Date().getFullYear();
  var displayName = tenantSiteDisplayName(tenant, 'Studio');
  var legal = '<footer class="luxe-footer-legal" data-bk-color-surface="about"' +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.legal') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<p class="luxe-footer-copy">' + footerLegalLineHtml(tenant) + '</p>') +
    '</footer>';
  if (tenant.showContactOnPage === false) return legal;
  var igHandle = tenant.instagramHandle ? tenant.instagramHandle.replace(/^@/, '') : '';
  var igUrl = igHandle ? 'https://instagram.com/' + igHandle : '';
  var connectPieces = [];
  if (igHandle) {
    connectPieces.push('<a href="' + esc(igUrl) + '" target="_blank" rel="noopener"><span data-edit-key="wc.contact.instagram">@' + esc(webCopyOverrideText(tenant, 'wc.contact.instagram', igHandle)) + '</span></a>');
  }
  if (tenant.contactEmail) {
    var emLo = String(tenant.contactEmail).trim();
    connectPieces.push('<a href="mailto:' + esc(emLo) + '">' + wcSpan(tenant, 'wc.contact.email', emLo) + '</a>');
  }
  if (tenant.contactPhone) {
    var luxePhHref = telHrefFromPhone(tenant.contactPhone);
    var phPlain = tenant.contactPhone ? displayPhoneUS(tenant.contactPhone) : '';
    connectPieces.push(luxePhHref
      ? ('<a href="' + esc(luxePhHref) + '">' + wcSpan(tenant, 'wc.contact.phone', phPlain) + '</a>')
      : wcSpan(tenant, 'wc.contact.phone', phPlain));
  }
  var connectHtml = connectPieces.length ? connectPieces.join('<br>') : wcSpan(tenant, 'wc.contact.email', 'Add in app');
  var luxeHoursTrim = tenantBusinessHoursTrimmed(tenant);
  var luxeHoursBlock = '';
  if (tenantShowBusinessHours(tenant)) {
    luxeHoursBlock = '<div class="luxe-contact-item"><h3>' + wcSpan(tenant, 'wc.luxe.contactHours', 'Hours') + '</h3><p style="white-space:pre-line">' +
      (luxeHoursTrim ? wcSpanMultiline(tenant, 'wc.contact.hours', luxeHoursTrim) : wcSpan(tenant, 'wc.contact.hours', 'Add in app')) + '</p></div>';
  }
  var addrTrim = tenantStreetAddressText(tenant);
  var saTrim = tenant.serviceArea && String(tenant.serviceArea).trim() ? String(tenant.serviceArea).trim() : '';
  var luxeLocRaw = addrTrim || saTrim || '';
  var luxeLocMaps = luxeLocRaw ? googleMapsSearchUrl(luxeLocRaw) : '';
  var luxeLocationInner;
  if (luxeLocRaw && luxeLocMaps) {
    luxeLocationInner = '<a href="' + esc(luxeLocMaps) + '" target="_blank" rel="noopener noreferrer">' + wcSpanMultiline(tenant, 'wc.contact.location', luxeLocRaw) + '</a>';
  } else if (luxeLocRaw) {
    luxeLocationInner = wcSpanMultiline(tenant, 'wc.contact.location', luxeLocRaw);
  } else {
    luxeLocationInner = wcSpan(tenant, 'wc.contact.serviceArea', 'Add in app');
  }
  return '<section class="luxe-contact" data-bk-color-surface="about"' +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.contact') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="luxe-contact-inner bk-fade-up">' +
      '<div class="luxe-contact-item"><h3>' + wcSpan(tenant, 'wc.luxe.contactLocation', 'Location') + '</h3><p>' + luxeLocationInner + '</p></div>' +
      luxeHoursBlock +
      '<div class="luxe-contact-item"><h3>' + wcSpan(tenant, 'wc.luxe.contactConnect', 'Connect') + '</h3><p>' + connectHtml + '</p></div>' +
    '</div>') +
  '</section>' + legal;
}

function luxeTenantProductCardsHtml(tenant, opts) {
  if (!tenant._products || !tenant._products.length) return '';
  opts = opts || {};
  var keyPrefix = (opts.surfaceKeyPrefix && String(opts.surfaceKeyPrefix).trim()) || '';
  var productCards = '';
  for (var pi = 0; pi < tenant._products.length; pi++) {
    var prod = tenant._products[pi];
    var prodImg = prod.imageUrl ? '<img src="' + esc(prod.imageUrl) + '" alt="" loading="lazy">' : '<div class="luxe-product-placeholder" aria-hidden="true"></div>';
    var priceHtml = '';
    if (prod.salePrice && prod.salePrice < prod.price) {
      priceHtml = '<div class="luxe-product-prices"><span class="luxe-product-price-sale">$' + Number(prod.salePrice).toFixed(2) + '</span><span class="luxe-product-price-original">$' + Number(prod.price).toFixed(2) + '</span></div>';
    } else {
      priceHtml = '<div class="luxe-product-prices"><span class="luxe-product-price">$' + Number(prod.price).toFixed(2) + '</span></div>';
    }
    var pid = prod.id ? String(prod.id) : ('i' + pi);
    var surfaceAttrs = '';
    if (keyPrefix) {
      if (isBladeTheme(tenant)) surfaceAttrs = bladeBkCardSurfaceAttrs(tenant, keyPrefix + pid);
      else if (isLuxeTheme(tenant)) {
        surfaceAttrs = ' data-bk-color-surface="card"' + luxeBkSurfaceKeyAttr(tenant, keyPrefix + pid);
      } else if (isStonecutTheme(tenant)) {
        surfaceAttrs = ' data-bk-color-surface="card"' + stonecutBkSurfaceKeyAttr(tenant, keyPrefix + pid);
      } else if (isStudio12Theme(tenant)) {
        surfaceAttrs = studio12BkCardSurfaceAttrs(tenant, keyPrefix + pid);
      }
    }
    productCards += '<button type="button" class="luxe-product-card luxe-product-card--btn"' + surfaceAttrs + ' data-product-id="' + esc(prod.id) + '">' + prodImg + (prod.category ? '<p class="luxe-product-category">' + esc(prod.category) + '</p>' : '') + '<h3>' + esc(prod.name) + '</h3>' + priceHtml + '</button>';
  }
  return productCards;
}

function luxeShopPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var nav = luxeChromeNavHtml(tenant, 'light');
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
  var productCards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'luxe.shopProduct.' });
  var inner = productCards
    ? '<div class="luxe-shop-inner"><p class="luxe-section-label">' + wcSpan(tenant, 'wc.luxe.shopEyebrow', 'Retail') + '</p><h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.luxe.shopHeading', 'Shop') + '</h2><p style="color:#888;max-width:420px;margin:0 auto;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.luxe.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><div class="luxe-shop-grid">' + productCards + '</div></div>'
    : '<div class="luxe-shop-inner"><p class="luxe-section-label">' + wcSpan(tenant, 'wc.luxe.shopEyebrow', 'Retail') + '</p><h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.luxe.shopHeading', 'Shop') + '</h2><p style="color:#888;max-width:420px;margin:0 auto;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.luxe.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><p class="gallery-empty-hint" style="color:#555;max-width:420px;margin:24px auto 0">No products yet. Check back soon.</p></div>';
  return '<div class="luxe-page luxe-page--sub luxe-shop-page">' + nav +
    '<div class="luxe-shop-page-shell" data-bk-color-surface="page"' +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.shopPage') +
    ' data-bk-band-tappable>' +
    bkColorBandInnerWrap(inner) + '</div>' +
    luxeContactSectionHtml(tenant) + sidebar + '</div>';
}

/** Default Luxe hero line when `luxeHeroTagline` is empty; matches `BookingTemplate` / tenant `industry`. */
function defaultLuxeHeroTaglineForIndustry(industry) {
  var k = String(industry || '').trim().toLowerCase();
  var map = {
    barber: 'Sharp cuts. Clean results. Every time.',
    hair: 'Elevated hair, tailored to you.',
    tattoos: 'Turn your idea into something permanent.',
    nails: 'Clean, polished, and done right.',
    charters: 'Time on the water, planned around you.',
    custom: 'Designed to deliver better results.'
  };
  return map[k] || map.custom;
}

/** Luxe promo strip `<h2>` when `luxePromoHeadline` is empty. */
function defaultLuxePromoHeadlineForIndustry(industry) {
  var k = String(industry || '').trim().toLowerCase();
  var map = {
    barber: 'Ready for Your Next Cut?',
    hair: 'Ready for Your Next Look?',
    tattoos: 'Ready for Your Next Piece?',
    nails: 'Ready for Your Next Set?',
    charters: 'Ready for Your Next Trip?',
    custom: 'Ready to Book Your Next Appointment?'
  };
  return map[k] || map.custom;
}

function luxeHomePage(tenant, services) {
  function luxeTenantTrim(key) {
    var v = tenant[key];
    if (v == null) return '';
    return String(v).trim();
  }
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var displayName = tenantSiteDisplayName(tenant, 'Welcome');

  var nav = luxeChromeNavHtml(tenant, 'hero');

  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';

  var heroClass = 'luxe-hero' + (tenant.heroImageUrl ? '' : ' luxe-hero--empty');
  var heroStyle = tenant.heroImageUrl
    ? 'background-image:url(' + esc(tenant.heroImageUrl) + ');'
    : '';
  var luxeHeroLine = tenantSiteTextOrCompute(tenant, 'luxeHeroTagline', function() {
    return defaultLuxeHeroTaglineForIndustry(tenant.industry);
  });

  var luxeHeroCta = tenantShowBookPage(tenant)
    ? '<a href="' + bookUrl + '" class="luxe-hero-cta" data-cta-key="wc.luxe.heroCta">' + wcSpan(tenant, 'wc.luxe.heroCta', 'Book Appointment') + '</a>'
    : '';
  /* Photo slot stays the hero image. The key lets the editor select the card; color never replaces the photo. */
  var hero = '<section class="' + heroClass + '" data-bk-color-surface="hero"' +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.hero') + ' data-bk-band-tappable' +
    (heroStyle ? ' style="' + heroStyle + '"' : '') + '>' +
    '<button type="button" class="bk-hero-image-hit luxe-hero-image-hit" data-edit-key="heroImage" aria-label="Change hero image"></button>' +
    '<div class="luxe-hero-inner">' +
      '<div class="luxe-hero-text bk-fade-up">' +
        '<h1>' + siteNameSpan(tenant, 'Welcome', 'displayName.luxe.hero') + '</h1>' +
        '<p>' + siteTextSpan('luxeHeroTagline', luxeHeroLine) + '</p>' +
        luxeHeroCta +
      '</div>' +
    '</div>' +
  '</section>';

  var stripEyebrow = tenantSiteText(tenant, 'luxeFeaturedWorkEyebrow', 'Gallery');
  var stripHeading = tenantSiteText(tenant, 'luxeFeaturedWorkHeading', 'Featured work');
  var showFeaturedStrip = tenantShowGalleryPage(tenant) && tenant.luxeShowFeaturedWorkStrip !== false;

  var servicesSection = '';
  if (showFeaturedStrip) {
    // Five slots so every gallery layout can fill its grid; section-layouts.css hides the extras.
    var maxCards = 5;
    var featuredImages = featuredUrlsForHomeStrip(tenant, maxCards);
    var serviceCards = '';
    for (var i = 0; i < maxCards; i++) {
      var fk = 'featuredWork:' + i;
      var slotUrl = featuredStripSlotUrl(featuredImages, i);
      var imgTag = slotUrl
        ? galleryLightboxTriggerHtml(slotUrl, {
            className: 'luxe-service-card-img-wrap',
            editAttr: ' data-edit-key="' + esc(fk) + '"'
          })
        : ('<div class="luxe-service-card-img-wrap"><div class="luxe-service-placeholder luxe-service-placeholder--add" data-edit-key="' + esc(fk) + '" role="button" aria-label="Add or change featured photo"></div></div>');
      serviceCards += '<div class="luxe-service-card bk-fade-up">' +
        imgTag +
      '</div>';
    }
    servicesSection = '<section id="gallery" class="luxe-services-section" data-bk-color-surface="featured"' +
      luxeBkSurfaceKeyAttr(tenant, 'luxe.featured') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<p class="luxe-section-label bk-fade-up">' + siteTextSpan('luxeFeaturedWorkEyebrow', stripEyebrow) + '</p>' +
      '<h2 class="luxe-section-heading bk-fade-up">' + siteTextSpan('luxeFeaturedWorkHeading', stripHeading) + '</h2>' +
      '<div class="luxe-services-grid">' + serviceCards + '</div>') +
    '</section>';
  }

  var shopPreviewSection = (function(){
    if (!tenantShowShopPage(tenant) || !tenant._products || !tenant._products.length) return '';
    var cards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'luxe.homeProduct.' });
    if (!cards) return '';
    var base = tenantBaseUrl(tenant);
    return '<section class="luxe-shop-preview-home" id="shop" data-bk-color-surface="card"' +
      luxeBkSurfaceKeyAttr(tenant, 'luxe.shop') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="luxe-shop-inner">' +
        '<p class="luxe-section-label">' + wcSpan(tenant, 'wc.luxe.shopEyebrow', 'Retail') + '</p>' +
        '<h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.luxe.shopHeading', 'Shop') + '</h2>' +
        '<p style="color:#888;max-width:420px;margin:0 auto;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.luxe.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p>' +
        '<div class="luxe-shop-grid" style="max-width:960px;margin:0 auto">' + cards + '</div>' +
        '<p style="text-align:center;margin-top:28px"><a href="' + base + '/shop" class="luxe-shop-view-all" data-cta-key="wc.luxe.shopViewAll">' + wcSpan(tenant, 'wc.luxe.shopViewAll', 'View full shop →') + '</a></p>' +
      '</div>') +
      '</section>';
  })();

  var homeServicesSection = '';
  if (tenant.luxeShowHomeServicesSection === true && services && services.length > 0) {
    var menuEyebrow = tenantSiteText(tenant, 'luxeHomeServicesEyebrow', 'Services');
    var menuHeading = tenantSiteText(tenant, 'luxeHomeServicesHeading', 'What we offer');
    var showLuxeHomeMenuDur = tenant.classicShowServiceDuration !== false;
    var menuRows = '';
    for (var li = 0; li < services.length; li++) {
      var ls = services[li];
      var pTxt = (typeof ls.price === 'number' && ls.price > 0) ? '$' + Number(ls.price).toFixed(0) : '';
      var dTrim = (ls.description && String(ls.description).trim()) ? String(ls.description).trim() : '';
      var luxeDur = (typeof ls.durationMinutes === 'number' && ls.durationMinutes > 0) ? ls.durationMinutes : null;
      var sidLx = ls.id ? String(ls.id) : '';
      var durH = showLuxeHomeMenuDur && luxeDur != null
        ? '<p class="luxe-home-service-dur">' + (sidLx ? svcSpan(tenant, sidLx, 'duration', 'About ' + String(luxeDur) + ' min') : ('About ' + esc(String(luxeDur)) + ' min')) + '</p>'
        : '';
      var priceH = pTxt ? '<div class="luxe-home-service-price">' + (sidLx ? svcSpan(tenant, sidLx, 'price', pTxt) : esc(pTxt)) + '</div>' : '';
      var luxeNameInner = sidLx ? svcSpan(tenant, sidLx, 'name', ls.name || 'Service') : esc(ls.name || 'Service');
      var descH = '';
      if (dTrim) {
        if (sidLx) {
          descH = '<p class="luxe-home-service-desc">' + svcSpanMultiline(tenant, sidLx, 'description', dTrim) + '</p>';
        } else {
          descH = '<p class="luxe-home-service-desc">' + esc(dTrim).replace(/\n/g, '<br>') + '</p>';
        }
      }
      menuRows += '<div class="luxe-home-service-row' + (tenant.luxeHomeServicesExpandableCard === true ? '' : ' bk-fade-up') + '"' + svcEditAttr(sidLx) + '>' +
        '<div class="luxe-home-service-copy">' +
        '<p class="luxe-home-service-name">' + luxeNameInner + '</p>' +
        durH +
        descH +
        '</div>' +
        priceH +
        '</div>';
    }
    var listInner = '<div class="luxe-home-service-list">' + menuRows + '</div>';
    if (tenant.luxeHomeServicesExpandableCard === true) {
      homeServicesSection = '<section id="services" class="luxe-home-services-section luxe-home-services-section--expandable bk-fade-up">' +
        '<details class="luxe-home-services-details">' +
        '<summary class="luxe-home-services-summary">' +
        '<div class="luxe-home-services-summary-text">' +
        '<p class="luxe-section-label">' + siteTextSpan('luxeHomeServicesEyebrow', menuEyebrow) + '</p>' +
        '<h2 class="luxe-section-heading">' + siteTextSpan('luxeHomeServicesHeading', menuHeading) + '</h2>' +
        '</div>' +
        '<span class="luxe-home-services-expand-hint">View menu</span>' +
        '</summary>' +
        listInner +
        '</details></section>';
    } else {
      homeServicesSection = '<section id="services" class="luxe-home-services-section">' +
        '<p class="luxe-section-label bk-fade-up">' + siteTextSpan('luxeHomeServicesEyebrow', menuEyebrow) + '</p>' +
        '<h2 class="luxe-section-heading bk-fade-up">' + siteTextSpan('luxeHomeServicesHeading', menuHeading) + '</h2>' +
        listInner +
        '</section>';
    }
    homeServicesSection = '<div class="luxe-home-services-band" data-bk-color-surface="card"' +
      luxeBkSurfaceKeyAttr(tenant, 'luxe.services') + ' data-bk-band-tappable>' + bkColorBandInnerWrap(homeServicesSection) + '</div>';
  }

  var promoTag = tenant.tagline || 'Book with confidence.';
  var promoHeadline = tenantSiteTextOrCompute(tenant, 'luxePromoHeadline', function() {
    return defaultLuxePromoHeadlineForIndustry(tenant.industry);
  });
  var promoCta = tenantShowBookPage(tenant)
    ? '<a href="' + bookUrl + '" class="luxe-promo-cta" data-cta-key="wc.luxe.promoCta">' + wcSpan(tenant, 'wc.luxe.promoCta', 'Book Now') + '</a>'
    : '';
  var promo = '<section class="luxe-promo" data-bk-color-surface="card"' +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.promo') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="luxe-promo-inner bk-fade-up">' +
      '<h2>' + siteTextSpan('luxePromoHeadline', promoHeadline) + '</h2>' +
      '<p>' + wcSpan(tenant, 'wc.luxe.promoTag', promoTag) + '</p>' +
      promoCta +
    '</div>') +
  '</section>';

  var aboutBodyPlain = (tenant.aboutText || tenant.tagline)
    ? String(tenant.aboutText || tenant.tagline).trim()
    : 'Add your story in the app to introduce yourself to clients.';
  var aboutBody = wcSpanMultiline(tenant, 'wc.luxe.teamBio', aboutBodyPlain);
  var teamCards = '';

  var teamSection = tenantShowAboutPage(tenant)
    ? '<section id="about" class="luxe-team-section" data-bk-color-surface="card"' +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.about') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="luxe-team-inner bk-fade-up">' +
      '<p class="luxe-section-label">' + wcSpan(tenant, 'wc.luxe.aboutEyebrow', 'About Us') + '</p>' +
      '<h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.luxe.teamMeetPrefix', 'Meet') + ' ' + siteNameSpan(tenant, 'Welcome', 'displayName.luxe.about') + '</h2>' +
      '<p class="luxe-team-bio">' + aboutBody + '</p>' +
      teamCards +
    '</div>') +
  '</section>'
    : '';

  var contact = luxeContactSectionHtml(tenant);
  var teamHome = teamHomeSectionHtml(tenant);

  // Header, hero (the nav sits over it), and contact stay fixed; everything between can be reordered or hidden.
  var sections = renderPageSections(tenant, 'home', [
    { id: 'featured', label: 'Featured', html: servicesSection },
    { id: 'shop', label: 'Shop', html: shopPreviewSection },
    { id: 'services', label: 'Services', html: homeServicesSection },
    { id: 'promo', label: 'Promo', html: promo },
    { id: 'about', label: 'About', html: teamSection },
    { id: 'team', label: 'Team', html: teamHome }
  ]);
  return '<div class="luxe-page">' + nav + hero + sections + contact + galleryLightboxShellHtml() + sidebar + '</div>';
}

function luxeShopCheckoutPage(tenant) {
  return webShopCheckoutShell(tenant, 'luxe-page luxe-page--sub', luxeChromeNavHtml(tenant, 'light'), luxeContactSectionHtml(tenant), 'luxe-shop-page-shell', 'luxe.checkout');
}
