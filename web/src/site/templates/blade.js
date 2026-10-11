/* Blade template. */

/** Blade: hero placeholder + key bands follow palette tokens. */
function applyBladeHomeBandColors(tenant) {
  if (!isBladeTheme(tenant)) return;
  var c = tenantColors(tenant);
  applyEmptyImageSlotColors(tenant);
  [].forEach.call(document.querySelectorAll('.blade-page .blade-book-panel, .blade-page #services, .blade-page .blade-testimonials, .blade-page .blade-info-half[data-bk-color-surface="card"]'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.card;
    el.style.color = c.fg;
  });
  [].forEach.call(document.querySelectorAll('.blade-page footer.blade-footer'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.aboutBg;
    el.style.color = c.aboutFg;
  });
}

/** Paint Blade /book root so outer fill is visible without touching global `--bk-bg` / home. */
function applyBladeBookingPageRootFill(col) {
  [].forEach.call(document.querySelectorAll('.blade-page:has(.booking-shell)'), function(root) {
    if (col && String(col).charAt(0) === '#') {
      try { root.style.setProperty('background', col, 'important'); }
      catch (e) { root.style.background = col; }
    } else if (col) {
      try { root.style.setProperty('background', col, 'important'); }
      catch (e2) { root.style.background = col; }
    } else {
      root.style.removeProperty('background');
    }
  });
}

/** Blade-only per-band paint key (`webSurfaceColors`). */
function bladeBkSurfaceKeyAttr(tenant, key) {
  if (!tenant || !key) return '';
  if (!isBladeTheme(tenant)) return '';
  return ' data-bk-surface-key="' + esc(key) + '"';
}

/** Blade card/block paint target — role `card` plus a unique key so fills never share tokens. */
function bladeBkCardSurfaceAttrs(tenant, key) {
  if (!tenant || !key || !isBladeTheme(tenant)) return '';
  return ' data-bk-color-surface="card"' + bladeBkSurfaceKeyAttr(tenant, key);
}

function isBladeTheme(tenant) {
  return tenant && tenant.resolvedWebThemeId === 'blade-v1';
}

/** Blade (blade-v1): fixed dark nav + gold accents; `anchorHome` for #section links from subpages. */
function bladeNavHtml(tenant, anchorHome) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var shopUrl = base + '/shop';
  var h = anchorHome || (base + '/home');
  var lis = '';
  if (tenantShowAboutPage(tenant)) lis += '<li><a href="' + h + '#about">About</a></li>';
  if (tenantShowTeamPage(tenant)) lis += '<li><a href="' + base + '/team">Team</a></li>';
  if (tenantShowGalleryPage(tenant)) lis += '<li><a href="' + galleryUrl + '">Gallery</a></li>';
  if (tenantShowShopPage(tenant)) lis += '<li><a href="' + shopUrl + '">Shop</a></li>';
  var bookBtn = tenantShowBookPage(tenant)
    ? '<a href="' + bookUrl + '" class="blade-nav-book" data-cta-key="wc.blade.navBook">' + wcSpan(tenant, 'wc.blade.navBook', 'Book now') + '</a>'
    : '';
  return '<nav class="blade-topnav" data-bk-color-surface="page"' + bladeBkSurfaceKeyAttr(tenant, 'blade.nav') + '>' +
    '<a href="' + base + '/home" class="blade-nav-logo">' + siteNameSpan(tenant, 'Studio', 'displayName.blade.nav') + '</a>' +
    '<div class="blade-nav-trailing">' +
    '<ul class="blade-nav-links">' + lis + '</ul>' +
    bookBtn +
    '<button class="tattoo-nav-menu blade-nav-menu-btn" type="button" aria-label="Menu">' +
    '<span class="blade-nav-menu-icon" aria-hidden="true">' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="16" viewBox="0 0 22 16" fill="none">' +
    '<path d="M1 1.5h20M1 8h20M1 14.5h20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
    '</svg></span></button>' +
    '</div></nav>';
}

function bindBladeChrome() {
  var root = document.getElementById('root');
  if (!root) return;
  var page = root.querySelector('.blade-page');
  if (!page) return;
  var nav = page.querySelector('.blade-topnav');
  if (nav) {
    function onNavScroll() {
      var activeNav = document.querySelector('.blade-page .blade-topnav');
      if (!activeNav) return;
      activeNav.classList.toggle('scrolled', window.scrollY > 48);
    }
    onNavScroll();
    if (!window.__bladeNavScrollBound) {
      window.__bladeNavScrollBound = true;
      window.addEventListener('scroll', onNavScroll, { passive: true });
    }
  }
  function bladeScrollToSection(id) {
    var sec = document.getElementById(id);
    if (sec && sec.scrollIntoView) {
      sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  page.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var m = href.match(/#(services|about|location)\b/);
    if (!m) return;
    e.preventDefault();
    bladeScrollToSection(m[1]);
  });
  if (typeof IntersectionObserver === 'undefined') return;
  var fadeEls = page.querySelectorAll('.blade-fade-up');
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('blade-visible');
      obs.unobserve(entry.target);
    });
  }, { threshold: 0.06, rootMargin: '0px 0px -32px 0px' });
  for (var bi = 0; bi < fadeEls.length; bi++) obs.observe(fadeEls[bi]);
}

/** Blade hero `<em>` line when `bladeHeroTagline` empty (after legacy `tagline` split). */
function defaultBladeHeroTaglineForIndustry(industry) {
  var k = String(industry || '').trim().toLowerCase();
  var map = {
    barber: 'Defined by detail',
    hair: 'Designed around you',
    tattoos: 'Designed to last',
    nails: 'Polished to perfection',
    charters: 'Built for the water',
    custom: 'Focused on results'
  };
  return map[k] || map.custom;
}

/** Blade hero paragraph under the name when `bladeHeroDescription` and `aboutText` empty. */
function defaultBladeHeroDescriptionForIndustry(industry) {
  var k = String(industry || '').trim().toLowerCase();
  var map = {
    barber: 'Modern cuts, clean fades, and consistent results. Every appointment is focused on precision, from consultation to final detail.',
    hair: 'From color to cut, every service is tailored to your look. We focus on results that feel natural, polished, and long-lasting.',
    tattoos: 'Every piece starts with your vision. We focus on clean execution, strong design, and results you’ll carry with confidence.',
    nails: 'Every set is crafted with care, delivering clean finishes and consistent results you can rely on.',
    charters: 'From half-day trips to full-day adventures, every charter is planned around your group, the conditions, and the experience you want on the water.',
    custom: 'Every service is delivered with attention to detail and a focus on consistent, high-quality results.'
  };
  return map[k] || map.custom;
}

function bladeHomePage(tenant, services) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var anchorHome = base + '/home';
  var displayName = tenantSiteDisplayName(tenant, 'Studio');
  var nav = bladeNavHtml(tenant, anchorHome);
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
  var tag = tenant.tagline || '';
  var emLine = tenantSiteTextOrCompute(tenant, 'bladeHeroTagline', function() {
    var legacyEm = tag.split('.')[0].trim();
    return legacyEm || defaultBladeHeroTaglineForIndustry(tenant.industry);
  });
  var heroDesc = tenantSiteTextOrCompute(tenant, 'bladeHeroDescription', function() {
    if (tenant.aboutText && String(tenant.aboutText).trim()) {
      return String(tenant.aboutText).trim();
    }
    return tag || defaultBladeHeroDescriptionForIndustry(tenant.industry);
  });
  if (heroDesc.length > 240) heroDesc = heroDesc.slice(0, 237) + '…';
  var sa = (tenant.serviceArea && String(tenant.serviceArea).trim()) ? String(tenant.serviceArea).trim() : '';
  var hoursTrimBlade = tenantBusinessHoursTrimmed(tenant);
  var eyebrow = sa
    ? sa
    : ((tenant.address && String(tenant.address).trim())
      ? String(tenant.address).trim().split('\n')[0]
      : ((tenantShowBusinessHours(tenant) && hoursTrimBlade) ? 'See our hours below' : displayName));
  var heroEyebrowEditKey = sa ? 'serviceArea' : ((tenant.address && String(tenant.address).trim()) ? 'contactAddress' : ((tenantShowBusinessHours(tenant) && hoursTrimBlade) ? 'businessHours' : 'displayName'));
  var heroEyebrowSpan = (function() {
    if (heroEyebrowEditKey === 'displayName') return siteNameSpan(tenant, 'Studio', 'displayName.blade.heroEyebrow');
    if (heroEyebrowEditKey === 'serviceArea') return wcSpan(tenant, 'wc.contact.serviceArea', eyebrow);
    if (heroEyebrowEditKey === 'contactAddress') return wcSpan(tenant, 'wc.contact.address', eyebrow);
    return wcSpan(tenant, 'wc.contact.hours', eyebrow);
  })();
  var heroRight = tenant.heroImageUrl
    ? '<img class="blade-hero-image" data-edit-key="heroImage" src="' + esc(tenant.heroImageUrl) + '" alt="">'
    : '<div class="blade-hero-placeholder" data-edit-key="heroImage" role="button" aria-label="Add hero image"></div>';
  var vertical = emLine.length > 52 ? emLine.slice(0, 50) + '…' : emLine;
  var svc = services || [];
  var serviceCards = '';
  for (var si = 0; si < svc.length; si++) {
    var s = svc[si];
    var num = (si + 1 < 10 ? '0' : '') + (si + 1);
    var desc = (s.description && String(s.description).trim()) ? String(s.description).trim() : 'Professional service tailored to you.';
    var priceTxt = (typeof s.price === 'number' && s.price > 0) ? ('From $' + Number(s.price).toFixed(0)) : 'Book for pricing';
    var href = base + '/book/' + (s.slug || '');
    var sidBl = s.id ? String(s.id) : '';
    var svcCardKey = sidBl ? ('blade.svcCard.' + sidBl) : ('blade.svcCard.i' + si);
    serviceCards += '<a href="' + esc(href) + '" class="blade-service-card blade-fade-up" data-bk-color-surface="card"' +
      bladeBkSurfaceKeyAttr(tenant, svcCardKey) + svcEditAttr(sidBl) + '>' +
      '<div class="blade-service-num">' + num + '</div>' +
      '<div class="blade-gold-rule"></div>' +
      '<div class="blade-service-name">' + svcSpan(tenant, sidBl, 'name', s.name || 'Service') + '</div>' +
      '<p class="blade-service-desc">' + svcSpanMultiline(tenant, sidBl, 'description', desc) + '</p>' +
      '<div class="blade-service-price">' + svcSpan(tenant, sidBl, 'price', priceTxt) + '</div>' +
      '</a>';
  }
  var servicesBody = serviceCards
    ? '<div class="blade-services-grid">' + serviceCards + '</div>'
    : '<p class="blade-section-desc blade-fade-up" style="max-width:none">' + wcSpan(tenant, 'wc.blade.servicesEmpty', 'Add active services in the app to list them here.') + '</p>';
  var servicesSection = '<section class="blade-section" id="services" data-bk-color-surface="card"' + bladeBkSurfaceKeyAttr(tenant, 'blade.services') + ' data-bk-band-tappable>' +
    bkColorBandHitButtonHtml() +
    '<div class="bk-band-content blade-band-content">' +
    '<div class="blade-section-header blade-fade-up">' +
    '<div><div class="blade-section-label">' + wcSpan(tenant, 'wc.blade.servicesEyebrow', 'What we offer') + '</div><h2 class="blade-section-title">' + wcSpan(tenant, 'wc.blade.servicesTitle', 'OUR SERVICES') + '</h2></div>' +
    '</div>' + servicesBody + '</div></section>';
  var shopPreviewSection = (function(){
    if (!tenantShowShopPage(tenant) || !tenant._products || !tenant._products.length) return '';
    var cards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'blade.homeProduct.' });
    if (!cards) return '';
    var base = tenantBaseUrl(tenant);
    return '<section class="blade-shop-preview" id="shop" data-bk-color-surface="card"' + bladeBkSurfaceKeyAttr(tenant, 'blade.shop') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="luxe-shop-inner">' +
        '<p class="luxe-section-label">' + wcSpan(tenant, 'wc.blade.shopEyebrow', 'Retail') + '</p>' +
        '<h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.blade.shopHeading', 'Shop') + '</h2>' +
        '<p style="color:#888;max-width:420px;margin:8px auto 0;text-align:center">' + wcSpan(tenant, 'wc.blade.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p>' +
        '<div class="luxe-shop-grid" style="max-width:960px;margin:0 auto">' + cards + '</div>' +
        '<p style="text-align:center;margin-top:28px"><a href="' + base + '/shop" class="blade-btn-ghost" data-cta-key="wc.blade.shopViewAll">' + wcSpan(tenant, 'wc.blade.shopViewAll', 'View full shop →') + '</a></p>' +
      '</div>') +
      '</section>';
  })();
  // Hero already shows the story; skip duplicate "WHO WE ARE" block. `#about` is on the hero for nav / /about.
  var gUrls = galleryPageImageUrls(tenant);
  var gallerySection = '';
  if (tenantShowGalleryPage(tenant) && gUrls.length) {
    function bladeMarqueeChunk(urls, includeEditKeys) {
      return urls.map(function(u, gi) {
        var editKey = includeEditKeys ? galleryImageEditKeyAttr(gi) : '';
        return '<div class="blade-gallery-item">' +
          galleryLightboxTriggerHtml(u, {
            className: 'blade-gallery-thumb',
            editAttr: editKey,
            loading: includeEditKeys
          }) + '</div>';
      }).join('');
    }
    gallerySection = '<section class="blade-gallery-strip" id="blade-gallery" data-bk-color-surface="featured"' + bladeBkSurfaceKeyAttr(tenant, 'blade.gallery') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap(
      '<div class="blade-section-header blade-fade-up" style="padding-right:40px">' +
      '<div><div class="blade-section-label">' + wcSpan(tenant, 'wc.blade.galleryEyebrow', 'Portfolio') + '</div><h2 class="blade-section-title">' + wcSpan(tenant, 'wc.blade.galleryTitle', 'THE GALLERY') + '</h2></div>' +
      '</div>' +
      '<div class="blade-gallery-marquee">' + bladeMarqueeChunk(gUrls, true) + bladeMarqueeChunk(gUrls, false) + '</div>') + '</section>';
  }
  var hoursSnippet = '';
  if (tenantShowBusinessHours(tenant)) {
    hoursSnippet = hoursTrimBlade
      ? '<div class="blade-hours-block">' + wcSpanMultiline(tenant, 'wc.contact.hours', hoursTrimBlade) + '</div>'
      : '<p class="blade-section-desc" style="margin-top:20px">' + wcSpan(tenant, 'wc.contact.hours', 'Hours from the app appear here.') + '</p>';
  }
  var bookPanelCtas = tenantShowBookPage(tenant)
    ? '<div class="blade-hero-cta" style="margin-top:28px">' +
      '<a href="' + bookUrl + '" class="blade-btn-primary" data-cta-key="wc.blade.bookPanelPrimary">' + wcSpan(tenant, 'wc.blade.bookPanelPrimary', 'Book now') + '</a>' +
      '<a href="' + anchorHome + '#services" class="blade-btn-ghost" data-cta-key="wc.blade.viewServices">' + wcSpan(tenant, 'wc.blade.viewServices', 'View services') + '</a>' +
      '</div>'
    : '<div class="blade-hero-cta" style="margin-top:28px">' +
      '<a href="' + anchorHome + '#services" class="blade-btn-ghost" data-cta-key="wc.blade.viewServices">' + wcSpan(tenant, 'wc.blade.viewServices', 'View services') + '</a>' +
      '</div>';
  var revs = tenant.reviews || [];
  var bookPanelReviews = '';
  var bookPanelReviewsClass = '';
  if (revs.length) {
    var tCards = '';
    for (var ri = 0; ri < Math.min(revs.length, 3); ri++) {
      var rv = revs[ri] || {};
      tCards += '<div class="blade-testimonial-card blade-fade-up"' +
        bladeBkCardSurfaceAttrs(tenant, 'blade.reviewCard.' + ri) + '>' +
        '<div class="blade-testimonial-stars">★★★★★</div>' +
        '<p class="blade-testimonial-text">“' + esc(rv.quote || '') + '”</p>' +
        '<div class="blade-testimonial-author">— ' + esc(rv.name || 'Client') +
        (rv.service ? (' · ' + esc(rv.service)) : '') + '</div></div>';
    }
    bookPanelReviews = '<div class="blade-book-panel-reviews blade-fade-up">' +
      '<div class="blade-section-label">' + wcSpan(tenant, 'wc.blade.reviewsEyebrow', 'Reviews') + '</div>' +
      '<h2 class="blade-section-title blade-book-panel-reviews-title">' + wcSpan(tenant, 'wc.blade.reviewsTitle', 'WHAT THEY SAY') + '</h2>' +
      '<div class="blade-testimonials-grid">' + tCards + '</div></div>';
    bookPanelReviewsClass = ' blade-book-panel--with-reviews';
  }
  var bookPanel = '<section class="blade-book-panel' + bookPanelReviewsClass + '" id="blade-booking" data-bk-color-surface="card"' + bladeBkSurfaceKeyAttr(tenant, 'blade.bookPanel') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="blade-book-panel-inner">' +
    '<div class="blade-book-panel-main blade-fade-up">' +
    '<div class="blade-section-label">' + wcSpan(tenant, 'wc.blade.bookPanelSectionLabel', 'Reserve') + '</div>' +
    '<h2 class="blade-book-title">' + wcSpan(tenant, 'wc.blade.bookPanelTitleLine1', 'BOOK YOUR') + '<br><span>' + wcSpan(tenant, 'wc.blade.bookPanelTitleLine2', 'APPOINTMENT') + '</span></h2>' +
    hoursSnippet +
    bookPanelCtas +
    '</div>' + bookPanelReviews + '</div>') + '</section>';
  var testimonialSection = '';
  var hoursInfo = '';
  if (tenantShowBusinessHours(tenant)) {
    hoursInfo = hoursTrimBlade
      ? '<div class="blade-about-body" style="margin-top:16px;white-space:pre-line">' + wcSpanMultiline(tenant, 'wc.contact.hours', hoursTrimBlade) + '</div>'
      : '<p class="blade-about-body" style="margin-top:16px">' + wcSpan(tenant, 'wc.contact.hours', 'Add business hours in the app.') + '</p>';
  }
  var phoneHref = telHrefFromPhone(tenant.contactPhone);
  var phoneDisplay = contactPhoneDisplayEscaped(tenant);
  var saWhere = (tenant.serviceArea && String(tenant.serviceArea).trim()) ? String(tenant.serviceArea).trim() : '';
  var addrRaw = tenantStreetAddressText(tenant);
  var addrLines = addrRaw ? addrRaw.split(/\n/).map(function(l){ return String(l).trim(); }).filter(function(x){ return x.length; }) : [];
  var whereHeadline = saWhere || addrLines[0] || 'Location';
  var whereHeadHtml = '<h3 class="blade-section-title blade-where-city" style="font-size:38px">' + wcSpan(tenant, 'wc.contact.whereHead', whereHeadline) + '</h3>';
  var whereBlock;
  if (addrRaw) {
    var mapsQuery = googleMapsSearchUrl(addrRaw);
    var innerAddrHtml = '';
    if (saWhere) {
      innerAddrHtml = wcSpanMultiline(tenant, 'wc.contact.address', addrRaw);
    } else if (addrLines.length > 1) {
      innerAddrHtml = wcSpanMultiline(tenant, 'wc.contact.address', addrLines.slice(1).join('\n'));
    }
    var bodyUnderHead = innerAddrHtml
      ? '<div class="blade-address-block blade-where-address-body">' + innerAddrHtml + '</div>'
      : '';
    whereBlock = whereHeadHtml +
      (bodyUnderHead ? '<a href="' + esc(mapsQuery) + '" class="blade-where-maps blade-address-link" target="_blank" rel="noopener noreferrer" aria-label="Open address in maps">' + bodyUnderHead + '</a>' : '');
  } else if (tenant.contactEmail && String(tenant.contactEmail).trim()) {
    var em = String(tenant.contactEmail).trim();
    whereBlock = whereHeadHtml +
      '<a href="' + esc('mailto:' + em) + '" class="blade-where-maps blade-address-link" aria-label="Email">' +
      '<div class="blade-address-block blade-where-address-body">' + wcSpan(tenant, 'wc.contact.email', em) + '</div></a>';
  } else if (saWhere) {
    var saMaps = googleMapsSearchUrl(saWhere);
    whereBlock = whereHeadHtml +
      '<a href="' + esc(saMaps) + '" class="blade-where-maps blade-address-link" target="_blank" rel="noopener noreferrer" aria-label="Open in maps">' + wcSpan(tenant, 'wc.blade.openMaps', 'Open in maps') + '</a>' +
      '<div class="blade-address-block" style="margin-top:12px;opacity:0.88;font-size:15px"><span data-edit-key="wc.blade.addressHint">' + esc('Add your street address in the app for full directions.') + '</span></div>';
  } else {
    whereBlock = whereHeadHtml + '<div class="blade-address-block"><span data-edit-key="wc.blade.addressHint">' + esc('Add your address in the app.') + '</span></div>';
  }
  var bladeInfoSectionClass = 'blade-info-section' + (!tenantShowBusinessHours(tenant) ? ' blade-info-section--single' : '');
  var whenHalfBlade = tenantShowBusinessHours(tenant)
    ? ('<div class="blade-info-half blade-fade-up" data-bk-color-surface="card"' + bladeBkSurfaceKeyAttr(tenant, 'blade.when') + ' data-bk-band-tappable>' +
      bkColorBandHitButtonHtml() +
      '<div class="bk-band-content blade-band-content">' +
      '<div class="blade-section-label">' + wcSpan(tenant, 'wc.blade.whenLabel', 'When') + '</div>' +
      '<h3 class="blade-section-title" style="font-size:38px">' + wcSpan(tenant, 'wc.blade.hoursTitle', 'HOURS') + '</h3>' + hoursInfo +
      '</div></div>')
    : '';
  var infoSection = '<div class="' + bladeInfoSectionClass + '" id="location">' +
    whenHalfBlade +
    '<div class="blade-info-half blade-fade-up" data-bk-color-surface="card"' + bladeBkSurfaceKeyAttr(tenant, 'blade.where') + ' data-bk-band-tappable>' +
    bkColorBandHitButtonHtml() +
    '<div class="bk-band-content blade-band-content">' +
    '<div class="blade-section-label">' + wcSpan(tenant, 'wc.blade.whereLabel', 'Where') + '</div>' +
    whereBlock +
    (phoneHref ? '<a href="' + esc(phoneHref) + '" class="blade-address-phone">' + wcSpan(tenant, 'wc.contact.phone', tenant.contactPhone ? displayPhoneUS(tenant.contactPhone) : '') + '</a>' : '') +
    '</div></div></div>';
  var footer = bladeSiteFooterHtml(tenant);
  var heroPrimary = tenantShowBookPage(tenant)
    ? '<a href="' + bookUrl + '" class="blade-btn-primary" data-cta-key="wc.blade.heroBook">' + wcSpan(tenant, 'wc.blade.heroBook', 'Book appointment') + '</a>'
    : '';
  var hero = '<section class="blade-hero" id="about" data-bk-color-surface="hero"' + bladeBkSurfaceKeyAttr(tenant, 'blade.hero') + '>' +
    bkColorBandHitButtonHtml() +
    '<div class="blade-hero-left" data-bk-hero-band-tappable>' +
    '<div class="blade-hero-eyebrow">' + heroEyebrowSpan + '</div>' +
    '<h1 class="blade-hero-title"><em>' + siteTextSpan('bladeHeroTagline', emLine) + '</em>' + siteNameSpan(tenant, 'Studio', 'displayName.blade.hero') + '</h1>' +
    '<p class="blade-hero-desc">' + siteTextSpan('bladeHeroDescription', heroDesc) + '</p>' +
    '<div class="blade-hero-cta">' +
    heroPrimary +
    '<a href="' + anchorHome + '#services" class="blade-btn-ghost" data-cta-key="wc.blade.heroViewServices">' + wcSpan(tenant, 'wc.blade.heroViewServices', 'View services') + '</a>' +
    '</div></div>' +
    '<div class="blade-hero-right">' + heroRight + '<div class="blade-hero-overlay"></div>' + bkHeroImageHitButtonHtml() + '</div>' +
    '<div class="blade-hero-vertical">' + siteTextSpan('bladeHeroTagline', vertical) + '</div></section>';
  return '<div class="blade-page">' + nav + hero + servicesSection + shopPreviewSection + gallerySection + bookPanel + testimonialSection + infoSection + teamHomeSectionHtml(tenant) + footer + galleryLightboxShellHtml() + sidebar + '</div>';
}

/** Blade `blade-footer`: wordmark, Instagram / Book / Gallery, then © line. */
function bladeSiteFooterHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var displayName = tenantSiteDisplayName(tenant, 'Studio');
  var y = new Date().getFullYear();
  var ig = tenant.instagramHandle ? String(tenant.instagramHandle).replace(/^@/, '') : '';
  var igUrl = ig ? ('https://instagram.com/' + encodeURIComponent(ig)) : '';
  var footerExtra = '';
  if (tenantShowBookPage(tenant)) footerExtra += '<li><a href="' + bookUrl + '">' + wcSpan(tenant, 'wc.blade.footerBook', 'Book') + '</a></li>';
  if (tenantShowGalleryPage(tenant)) footerExtra += '<li><a href="' + galleryUrl + '">' + wcSpan(tenant, 'wc.blade.footerGallery', 'Gallery') + '</a></li>';
  return '<footer class="blade-footer" data-bk-color-surface="about"' + bladeBkSurfaceKeyAttr(tenant, 'blade.footer') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="blade-footer-logo">' + siteNameSpan(tenant, 'Studio', 'displayName.blade.footer') + '</div>' +
    '<ul class="blade-footer-links">' +
    (igUrl ? '<li><a href="' + esc(igUrl) + '" target="_blank" rel="noopener noreferrer">' + wcSpan(tenant, 'wc.blade.footerInstagram', 'Instagram') + '</a></li>' : '') +
    footerExtra +
    '</ul>' +
    '<p class="blade-footer-copy">' + footerLegalLineHtml(tenant) + '</p>') +
    '</footer>';
}

function bladeShopPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var nav = bladeNavHtml(tenant, base + '/home');
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
  var productCards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'blade.shopProduct.' });
  var inner = productCards
    ? '<div class="luxe-shop-inner"><p class="luxe-section-label">' + wcSpan(tenant, 'wc.blade.shopEyebrow', 'Retail') + '</p><h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.blade.shopHeading', 'Shop') + '</h2><p style="color:#888;max-width:420px;margin:0 auto;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.blade.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><div class="luxe-shop-grid">' + productCards + '</div></div>'
    : '<div class="luxe-shop-inner"><p class="luxe-section-label">' + wcSpan(tenant, 'wc.blade.shopEyebrow', 'Retail') + '</p><h2 class="luxe-section-heading">' + wcSpan(tenant, 'wc.blade.shopHeading', 'Shop') + '</h2><p style="color:#888;max-width:420px;margin:0 auto;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.blade.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><p class="gallery-empty-hint" style="color:#888;max-width:420px;margin:24px auto 0">No products yet. Add them in the app.</p></div>';
  return '<div class="blade-page blade-page--sub">' + nav +
    '<div class="blade-shop-page-shell" data-bk-color-surface="page"' + bladeBkSurfaceKeyAttr(tenant, 'blade.shopPage') + ' data-bk-band-tappable>' +
    inner + '</div>' + bladeSiteFooterHtml(tenant) + sidebar + '</div>';
}

function bladeShopCheckoutPage(tenant) {
  var base = tenantBaseUrl(tenant);
  return webShopCheckoutShell(tenant, 'blade-page blade-page--sub', bladeNavHtml(tenant, base + '/home'), bladeSiteFooterHtml(tenant), 'blade-shop-page-shell', 'blade.checkout');
}
