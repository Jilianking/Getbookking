/* Classic templates (hair, barber, tattoo, nails). */

/** Classic home: empty featured slots + hero placeholder follow card/accent tokens. */
function applyClassicHomePlaceholderColors(tenant) {
  if (!isClassicTheme(tenant) || isStudio12Theme(tenant)) return;
  applyEmptyImageSlotColors(tenant);
}

/** Classic (not Studio 12) per-band paint key (`webSurfaceColors`). */
function classicBkSurfaceKeyAttr(tenant, key) {
  if (!tenant || !key) return '';
  if (!isClassicTheme(tenant) || isStudio12Theme(tenant)) return '';
  return ' data-bk-surface-key="' + esc(key) + '"';
}

function classicStatPick(tenant, key, fallback) {
  return tenantSiteText(tenant, key, fallback);
}

function isClassicTheme(tenant) {
  return tenant && !isLuxeTheme(tenant) && !isBladeTheme(tenant) && !isStonecutTheme(tenant) && !isCharterTheme(tenant);
}

function tattooNavHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var displayName = tenantSiteDisplayName(tenant, 'Welcome');
  var inner = '<a href="' + base + '/home">Home</a>';
  if (tenantShowGalleryPage(tenant)) inner += '<a href="' + galleryUrl + '">Gallery</a>';
  if (tenantShowTeamPage(tenant)) inner += '<a href="' + base + '/team">Team</a>';
  if (tenantShowShopPage(tenant)) inner += '<a href="' + base + '/shop">Shop</a>';
  if (tenantShowAboutPage(tenant)) inner += '<a href="' + base + '/about">About</a>';
  if (tenantShowBookPage(tenant)) inner += '<a href="' + bookUrl + '">Booking</a>';
  var classicNavAttr = (isClassicTheme(tenant) && !isStudio12Theme(tenant))
    ? (' data-bk-color-surface="page"' + classicBkSurfaceKeyAttr(tenant, 'classic.nav'))
    : '';
  return '<nav class="tattoo-nav"' + classicNavAttr + '>' +
    '<a href="' + base + '/home" class="tattoo-brand">' + navBrandHtml(tenant, siteNameSpan(tenant, 'Welcome', 'displayName.classic.nav')) + '</a>' +
    '<div class="tattoo-nav-trailing">' +
      '<div class="tattoo-nav-links">' + inner + '</div>' +
    '<button class="tattoo-nav-menu" type="button" aria-label="Menu">' + hamburgerMenuSvg() + '</button>' +
    '</div>' +
  '</nav>';
}

/** Intentionally empty: business image stays profile-only in the app; headlines use display name + fonts. */
function tattooHeadlineLogoHtml(tenant) {
  return '';
}

/** Tattoo template: one editable theme for Featured, Gallery, Book, sidebar. */
function tattooSiteThemeInlineStyle(tenant) {
  if (isClassicTheme(tenant) && !isStudio12Theme(tenant)) {
    return tenantPageStyle(tenant, 'page');
  }
  return tenantPageStyle(tenant, 'featured');
}

function tattooSidebarPanelInlineStyle(tenant) {
  var sc = sidebarChromeResolved(tenant);
  if (isBladeTheme(tenant) || isStonecutTheme(tenant)) {
    return 'background:' + sc.bg;
  }
  if (usesAccentSidebarDrawer(tenant)) {
    return 'background:var(--bk-sidebar-accent-bg,' + sc.bg + ')' +
      ';color:var(--bk-sidebar-accent-fg,' + sc.fg + ')' +
      ';--bk-sidebar-divider:var(--bk-sidebar-accent-divider,' +
        rgbaFromHex(sc.fg, 0.28) + ')';
  }
  return tattooSiteThemeInlineStyle(tenant);
}

function tattooSidebarPanelOpenTag(tenant) {
  var cls = 'tattoo-sidebar-panel';
  if (usesAccentSidebarDrawer(tenant)) cls += ' tattoo-sidebar-panel--accent';
  return '<div class="' + cls + '" style="' + tattooSidebarPanelInlineStyle(tenant) + '">';
}

/** Drawer wordmark: same Unbounded uppercase treatment as Stonecut home nav (all themes). */
function tattooSidebarDisplayNameStyleKey(tenant) {
  if (isBladeTheme(tenant)) return 'displayName.blade.sidebar';
  if (isLuxeTheme(tenant)) return 'displayName.luxe.sidebar';
  if (isClassicTheme(tenant) && !isStudio12Theme(tenant)) return 'displayName.classic.sidebar';
  if (isStonecutTheme(tenant)) return 'displayName.stonecut.sidebar';
  if (isStudio12Theme(tenant)) return 'displayName.s12.sidebar';
  if (isCharterTheme(tenant)) return 'displayName.charter.sidebar';
  return 'displayName.sidebar';
}

function tattooSidebarBrandHtml(tenant, base) {
  var name = tenantSiteDisplayName(tenant, '');
  if (!name) return '';
  var b = (base != null && String(base)) ? String(base).replace(/\/$/, '') : '';
  var homeHref = b ? (b + '/home') : '#';
  return '<div class="tattoo-sidebar-brand">' +
    '<a href="' + esc(homeHref) + '" class="tattoo-sidebar-wordmark">' +
    // Phones show the brand here (no top bar): logo / name / both, same as the header.
    navBrandHtml(tenant, siteNameSpan(tenant, 'Studio', tattooSidebarDisplayNameStyleKey(tenant))) +
    '</a>' +
    '<button type="button" class="tattoo-sidebar-close" aria-label="Close menu">' + hamburgerMenuSvg() + '</button>' +
    '</div>';
}

function tattooSidebarPanelContentHtml(tenant, base, bookUrl) {
  return tattooSidebarBrandHtml(tenant, base) + sidebarLinksHtml(tenant, base, bookUrl);
}

/** Classic home-style bottom bar (brand + Instagram / Location / Hours). `nameFallback` when site name empty. */
function classicSiteFooterHtml(tenant, nameFallback) {
  var custom = customSiteFooterHtml(tenant, {
    attrs: ' data-bk-color-surface="page"' + classicBkSurfaceKeyAttr(tenant, 'classic.footer')
  });
  if (custom) return custom;
  var base = tenantBaseUrl(tenant);
  var igHandle = tenant.instagramHandle ? tenant.instagramHandle.replace(/^@/, '') : '';
  var igUrl = igHandle ? 'https://instagram.com/' + igHandle : '';
  var footerLinks = '';
  if (igHandle) footerLinks += '<a href="' + esc(igUrl) + '" target="_blank" rel="noopener">Instagram</a>';
  var footAbout = tenantShowAboutPage(tenant) ? (base + '/home#about') : (base + '/home#services');
  var footAddr = tenantStreetAddressText(tenant)
    || (tenant.serviceArea && String(tenant.serviceArea).trim())
    || '';
  var footMaps = footAddr ? googleMapsSearchUrl(footAddr) : '';
  if (footAddr && footMaps) {
    footerLinks += '<a href="' + esc(footMaps) + '" target="_blank" rel="noopener noreferrer">Location</a>';
  } else if (footAddr) {
    footerLinks += '<a href="' + footAbout + '">Location</a>';
  }
  if (tenantShowBusinessHours(tenant) && tenantBusinessHoursTrimmed(tenant)) footerLinks += '<a href="' + footAbout + '">Hours</a>';
  var y = new Date().getFullYear();
  return '<footer class="classic-footer" data-bk-color-surface="page"' +
    classicBkSurfaceKeyAttr(tenant, 'classic.footer') + '>' +
    '<div class="classic-footer-brand">' + siteNameSpan(tenant, nameFallback || 'Studio', 'displayName.classic.footer') + '</div>' +
    '<div class="classic-footer-links">' + footerLinks + '</div>' +
    '<p class="classic-footer-copy">' + footerLegalLineHtml(tenant) + '</p>' +
    '</footer>';
}

/** Shared Classic redesign: warm cream, split hero, services list, dark about with stats, clean footer. */
function classicHomePage(tenant, services, opts) {
  function classicTenantTrim(key) {
    var v = tenant[key];
    if (v == null) return '';
    return String(v).trim();
  }
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var displayName = tenantSiteDisplayName(tenant, opts.defaultName);

  var navInner = '';
  if (tenantShowGalleryPage(tenant)) navInner += '<a href="' + galleryUrl + '">Gallery</a>';
  navInner += '<a href="#services">Services</a>';
  if (tenantShowAboutPage(tenant)) navInner += '<a href="#about">About</a>';
  if (tenantShowTeamPage(tenant)) navInner += '<a href="' + base + '/team">Team</a>';
  if (tenantShowShopPage(tenant)) navInner += '<a href="' + base + '/shop">Shop</a>';
  if (tenantShowBookPage(tenant)) navInner += '<a href="' + bookUrl + '" class="classic-nav-book" data-cta-key="wc.classic.navBook">' + wcSpan(tenant, 'wc.classic.navBook', 'Book') + '</a>';
  var nav = '<nav class="tattoo-nav" data-bk-color-surface="page"' +
    classicBkSurfaceKeyAttr(tenant, 'classic.nav') + '>' +
    '<a href="' + base + '/home" class="tattoo-brand">' + navBrandHtml(tenant, siteNameSpan(tenant, opts.defaultName, 'displayName.classic.nav')) + '</a>' +
    '<div class="tattoo-nav-trailing">' +
      '<div class="tattoo-nav-links">' + navInner + '</div>' +
    '<button class="tattoo-nav-menu" type="button" aria-label="Menu">' + hamburgerMenuSvg() + '</button>' +
    '</div>' +
  '</nav>';

  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>';

  var tagParts = [];
  if (opts.industryLabel) tagParts.push(opts.industryLabel);
  var sa = tenant.serviceArea || '';
  if (sa) tagParts.push(sa);
  var heroTag = tagParts.length ? tagParts.join(' \u00b7 ') : '';

  var heroImgHtml = tenant.heroImageUrl
    ? '<img data-edit-key="heroImage" src="' + esc(tenant.heroImageUrl) + '" alt="' + esc(displayName) + '">'
    : '<div class="classic-hero-placeholder" data-edit-key="heroImage" role="button" aria-label="Add hero image"></div>';
  var heroRightStyle = '';

  var heroActions = '';
  if (tenantShowBookPage(tenant)) heroActions += '<a href="' + bookUrl + '" class="classic-btn-primary" data-cta-key="wc.classic.heroBook">' + wcSpan(tenant, 'wc.classic.heroBook', opts.bookLabel) + '</a>';
  if (tenantShowGalleryPage(tenant)) heroActions += '<a href="' + galleryUrl + '" class="classic-btn-ghost" data-cta-key="wc.classic.heroGallery">' + wcSpan(tenant, 'wc.classic.heroGallery', 'View work') + '</a>';
  var heroTitleRow =
    '<div class="classic-hero-title-row">' +
    '<h1 class="classic-hero-name">' + siteNameSpan(tenant, opts.defaultName, 'displayName.classic.hero') + '</h1>' +
    '<div class="classic-hero-nav-actions">' +
    '<button type="button" class="tattoo-nav-menu classic-hero-nav-menu" aria-label="Menu">' + hamburgerMenuSvg() + '</button>' +
    '</div></div>';
  var taglineTrim = classicTenantTrim('tagline');
  var heroTagInner;
  if (taglineTrim) {
    heroTagInner = wcSpan(tenant, 'wc.classic.heroTag', taglineTrim);
  } else if (heroTag) {
    heroTagInner = wcSpan(tenant, 'wc.classic.heroTag', heroTag);
  } else {
    heroTagInner = wcSpan(tenant, 'wc.classic.heroTagline', 'Book with confidence');
  }
  var heroIndustry = '<p class="classic-hero-tag">' + heroTagInner + '</p>';
  var heroHtml = '<section class="classic-hero" data-bk-color-surface="hero"' +
    classicBkSurfaceKeyAttr(tenant, 'classic.hero') + '>' +
    bkHeroBandHitButtonHtml() +
    '<div class="classic-hero-left bk-fade-up" data-bk-hero-band-tappable>' +
    heroTitleRow +
    heroIndustry +
    '<div class="classic-hero-actions">' + heroActions + '</div></div>' +
    '<div class="classic-hero-right"' + heroRightStyle + '>' + heroImgHtml + bkHeroImageHitButtonHtml() + '</div>' +
    '</section>';

  var classicFeaturedEyebrow = tenantSiteText(tenant, 'classicFeaturedWorkEyebrow', 'Featured work');
  var classicFeaturedHeading = tenantSiteText(tenant, 'classicFeaturedWorkHeading', opts.featuredHeading);
  var classicFeaturedSub = tenantSiteText(tenant, 'classicFeaturedWorkSub', opts.featuredSub);
  var classicFeaturedEmpty = tenantSiteText(tenant, 'classicFeaturedWorkEmpty', opts.featuredEmpty);
  var classicSvcEyebrow = tenantSiteText(tenant, 'classicServicesEyebrow', 'Services');
  var classicSvcHeading = tenantSiteText(tenant, 'classicServicesHeading', 'What I offer');
  var classicSvcExpand = tenant.classicServicesExpandableCard === true;

  var featuredHtml = '';
  if (tenantShowGalleryPage(tenant)) {
    var gridCols = 3;
    var gridRows = 1;
    // Five slots so every gallery layout can fill its grid; section-layouts.css hides the extras.
    var maxCells = 5;
    var gallery = featuredUrlsForHomeStrip(tenant, maxCells);
    var gridStyle = 'grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(1,1fr);';
    var featuredGridInner = (function() {
      var cells = [];
      for (var fi = 0; fi < maxCells; fi++) {
        var fk = 'featuredWork:' + fi;
        var slotUrl = featuredStripSlotUrl(gallery, fi);
        if (slotUrl) {
          cells.push(galleryLightboxTriggerHtml(slotUrl, {
            className: 'tattoo-featured-cell bk-fade-up',
            editAttr: ' data-edit-key="' + esc(fk) + '"'
          }));
        } else {
          cells.push('<div class="tattoo-featured-cell tattoo-featured-slot-add bk-fade-up" data-edit-key="' + esc(fk) + '" role="button" aria-label="Add or change featured photo"></div>');
        }
      }
      return cells.length ? cells.join('') : ('<div class="tattoo-featured-placeholder bk-fade-up" data-edit-key="classicFeaturedWorkEmpty" role="button" aria-label="Edit featured work empty message">' + esc(opts.galleryPlaceholder) + '</div>');
    })();
    featuredHtml = '<section id="featured" class="tattoo-featured-outer" data-bk-color-surface="featured"' +
      classicBkSurfaceKeyAttr(tenant, 'classic.featured') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="tattoo-featured-inner">' +
      '<p class="classic-section-eyebrow bk-fade-up">' + siteTextSpan('classicFeaturedWorkEyebrow', classicFeaturedEyebrow) + '</p>' +
      '<h2 class="bk-fade-up">' + siteTextSpan('classicFeaturedWorkHeading', classicFeaturedHeading) + '</h2>' +
      '<p class="tattoo-featured-sub bk-fade-up">' + siteTextSpan((gallery.length ? 'classicFeaturedWorkSub' : 'classicFeaturedWorkEmpty'), (gallery.length ? classicFeaturedSub : classicFeaturedEmpty)) + '</p>' +
      '<div class="tattoo-featured-grid" style="'+gridStyle+'">' + featuredGridInner + '</div>' +
      '<a href="'+esc(galleryUrl)+'" class="tattoo-gallery-link bk-fade-up">' + wcSpan(tenant, 'wc.classic.galleryLink', 'View full gallery \u2192') + '</a>' +
      '</div>') + '</section>';
  }

  var servicesHtml = '';
  if (services && services.length > 0) {
    var rows = '';
    var showClassicServiceDur = tenant.classicShowServiceDuration !== false;
    for (var si = 0; si < services.length; si++) {
      var s = services[si];
      var priceTxt = (typeof s.price === 'number' && s.price > 0) ? '$' + Number(s.price).toFixed(0) : '';
      var descTrim = (s.description && String(s.description).trim()) ? String(s.description).trim() : '';
      var dur = (typeof s.durationMinutes === 'number' && s.durationMinutes > 0) ? s.durationMinutes : null;
      var sidCl = s.id ? String(s.id) : '';
      var durLabel = dur != null ? ('About ' + String(dur) + ' min') : '';
      var durHtml = showClassicServiceDur && dur != null
        ? '<p class="classic-service-e-dur">' + (sidCl ? svcSpan(tenant, sidCl, 'duration', durLabel) : esc(durLabel)) + '</p>'
        : '';
      var priceHtml = priceTxt
        ? '<p class="classic-service-menu-price">' + (sidCl ? svcSpan(tenant, sidCl, 'price', priceTxt) : esc(priceTxt)) + '</p>'
        : '';
      var priceCol = priceTxt
        ? '<div class="classic-service-e-price-col">' + priceHtml + '</div>'
        : '';
      var titleH = '<p class="classic-service-e-title">' + (sidCl ? svcSpan(tenant, sidCl, 'name', s.name || 'Service') : esc(s.name || 'Service')) + '</p>';
      var descBlock = '';
      if (descTrim) {
        var descBr = esc(descTrim).replace(/\n/g, '<br>');
        if (sidCl) {
          descBlock = '<div class="classic-service-e-desc">' + svcSpanMultiline(tenant, sidCl, 'description', descTrim) + '</div>';
        } else {
          descBlock = '<div class="classic-service-e-desc">' + descBr + '</div>';
        }
      }
      rows += '<div class="classic-service-item classic-service-item--e' + (classicSvcExpand ? '' : ' bk-fade-up') + '"' + svcEditAttr(sidCl) + '>' +
        '<div class="classic-service-e-row">' +
        '<div class="classic-service-e-copy">' +
        titleH +
        durHtml +
        descBlock +
        '</div>' +
        priceCol +
        '</div></div>';
    }
    var listBlock = '<div class="classic-service-list">' + rows + '</div>';
    if (classicSvcExpand) {
      servicesHtml = '<section id="services" class="classic-services-section classic-services-section--expandable" data-bk-color-surface="card"' +
        classicBkSurfaceKeyAttr(tenant, 'classic.services') + ' data-bk-band-tappable>' +
        bkColorBandInnerWrap('<div class="classic-services bk-fade-up">' +
        '<details class="classic-services-details">' +
        '<summary class="classic-services-summary">' +
        '<div class="classic-services-summary-text">' +
        '<p class="classic-section-eyebrow">' + siteTextSpan('classicServicesEyebrow', classicSvcEyebrow) + '</p>' +
        '<h2>' + siteTextSpan('classicServicesHeading', classicSvcHeading) + '</h2>' +
        '</div>' +
        '<span class="classic-services-expand-hint">View menu</span>' +
        '</summary>' +
        listBlock +
        '</details></div>') + '</section>';
    } else {
      servicesHtml = '<section id="services" class="classic-services-section" data-bk-color-surface="card"' +
        classicBkSurfaceKeyAttr(tenant, 'classic.services') + ' data-bk-band-tappable>' +
        bkColorBandInnerWrap('<div class="classic-services">' +
        '<p class="classic-section-eyebrow bk-fade-up">' + siteTextSpan('classicServicesEyebrow', classicSvcEyebrow) + '</p>' +
        '<h2 class="bk-fade-up">' + siteTextSpan('classicServicesHeading', classicSvcHeading) + '</h2>' +
        listBlock +
        '</div>') + '</section>';
    }
  }

  var shopPreviewSection = (function(){
    if (!tenantShowShopPage(tenant) || !tenant._products || !tenant._products.length) return '';
    var cards = luxeTenantProductCardsHtml(tenant);
    if (!cards) return '';
    var base = tenantBaseUrl(tenant);
    return '<section class="classic-shop-preview-home" id="shop" data-bk-color-surface="card"' +
      classicBkSurfaceKeyAttr(tenant, 'classic.shop') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="luxe-shop-inner">' +
        '<p class="classic-section-eyebrow">' + wcSpan(tenant, 'wc.classic.shopEyebrow', 'Retail') + '</p>' +
        '<h2 style="font-family:var(--font-display);font-size:1.6rem;font-weight:600;margin:0 0 8px">' + wcSpan(tenant, 'wc.classic.shopHeading', 'Shop') + '</h2>' +
        '<p style="color:#888;max-width:420px;margin:0 auto 12px;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.classic.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p>' +
        '<div class="luxe-shop-grid" style="max-width:960px;margin:0 auto">' + cards + '</div>' +
        '<p style="text-align:center;margin-top:28px"><a href="' + base + '/shop" class="classic-btn-ghost" data-cta-key="wc.classic.shopViewAll">' + wcSpan(tenant, 'wc.classic.shopViewAll', 'View full shop →') + '</a></p>' +
      '</div>') +
      '</section>';
  })();

  var aboutBioPlain = ((tenant.aboutText && String(tenant.aboutText).trim()) || (tenant.tagline && String(tenant.tagline).trim()) || String(opts.defaultBio || '').trim());
  var aboutBioDisplay = wcSpanMultiline(tenant, 'wc.classic.aboutBio', aboutBioPlain || 'Tell clients about your work and experience.');
  var classicContactLines = '';
  if (tenant.showContactOnPage !== false) {
    var clAddr = tenantStreetAddressText(tenant)
      || (tenant.serviceArea && String(tenant.serviceArea).trim())
      || '';
    var clLines = [];
    if (clAddr) {
      var clMaps = googleMapsSearchUrl(clAddr);
      var addrInner = wcSpanMultiline(tenant, 'wc.contact.location', clAddr);
      if (clMaps) {
        clLines.push('<a href="' + esc(clMaps) + '" target="_blank" rel="noopener noreferrer">' + addrInner + '</a>');
      } else {
        clLines.push(addrInner);
      }
    }
    var clTel = telHrefFromPhone(tenant.contactPhone);
    if (tenant.contactPhone && clTel) {
      clLines.push('<a href="' + esc(clTel) + '">' + wcSpan(tenant, 'wc.contact.phone', displayPhoneUS(tenant.contactPhone)) + '</a>');
    } else if (tenant.contactPhone) {
      clLines.push(wcSpan(tenant, 'wc.contact.phone', displayPhoneUS(tenant.contactPhone)));
    }
    if (tenant.contactEmail) {
      var em = String(tenant.contactEmail).trim();
      clLines.push('<a href="mailto:' + esc(em) + '">' + wcSpan(tenant, 'wc.contact.email', em) + '</a>');
    }
    if (clLines.length) {
      classicContactLines = '<div class="classic-about-contact-lines">' + clLines.join('<br>') + '</div>';
    }
  }
  var classicStatsHtml = '';
  if (tenant.classicShowAboutStats !== false) {
    var yv = classicStatPick(tenant, 'classicStatYearsValue', '8+');
    var yl = classicStatPick(tenant, 'classicStatYearsLabel', 'Years exp.');
    var cv = classicStatPick(tenant, 'classicStatClientsValue', '500+');
    var cl = classicStatPick(tenant, 'classicStatClientsLabel', 'Clients');
    var rv = classicStatPick(tenant, 'classicStatRatedValue', '5\u2605');
    var rl = classicStatPick(tenant, 'classicStatRatedLabel', 'Rated');
    classicStatsHtml =
      '<div class="classic-stats">' +
      '<div class="classic-stat"><div class="classic-stat-value">' + siteTextSpan('classicStatYearsValue', yv) + '</div><div class="classic-stat-label">' + siteTextSpan('classicStatYearsLabel', yl) + '</div></div>' +
      '<div class="classic-stat"><div class="classic-stat-value">' + siteTextSpan('classicStatClientsValue', cv) + '</div><div class="classic-stat-label">' + siteTextSpan('classicStatClientsLabel', cl) + '</div></div>' +
      '<div class="classic-stat"><div class="classic-stat-value">' + siteTextSpan('classicStatRatedValue', rv) + '</div><div class="classic-stat-label">' + siteTextSpan('classicStatRatedLabel', rl) + '</div></div>' +
      '</div>';
  }
  var aboutEyebrow = tenantSiteText(tenant, 'classicAboutEyebrow', 'About');
  var aboutHeadingHtml;
  if (tenantSiteTextIsBlank(tenant, 'classicAboutHeading')) {
    aboutHeadingHtml = '<h2>' + siteTextSpan('classicAboutHeading', '') + '</h2>';
  } else {
    var aboutHeadingCustom = tenantSiteText(tenant, 'classicAboutHeading', '');
    aboutHeadingHtml = aboutHeadingCustom
      ? ('<h2>' + siteTextSpanWithInlineEm('classicAboutHeading', aboutHeadingCustom) + '</h2>')
      : ('<h2>' + siteTextSpanWithInlineEm('classicAboutHeading', opts.aboutHeading) + '</h2>');
  }
  var aboutPhotoHtml = tenant.classicAboutImageUrl
    ? '<img class="classic-about-photo" data-edit-key="classicAboutImage" src="' + esc(tenant.classicAboutImageUrl) + '" alt="">'
    : '<div class="classic-about-photo classic-about-photo--empty" data-edit-key="classicAboutImage" role="button" aria-label="Add about photo"></div>';
  var aboutHtml = tenantShowAboutPage(tenant)
    ? '<section id="about" class="classic-about-section" data-bk-color-surface="about"' +
    classicBkSurfaceKeyAttr(tenant, 'classic.about') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="classic-about-inner-v2">' +
    '<div class="classic-about-copy bk-fade-up">' +
    '<p class="classic-section-eyebrow">' + siteTextSpan('classicAboutEyebrow', aboutEyebrow) + '</p>' +
    aboutHeadingHtml +
    '<p class="classic-about-bio-v2">' + aboutBioDisplay + '</p>' +
    classicStatsHtml +
    classicContactLines +
    '</div>' +
    '<div class="classic-about-media bk-fade-up">' + aboutPhotoHtml + '</div>' +
    '</div>') + '</section>'
    : '';

  var footerHtml = classicSiteFooterHtml(tenant, opts.defaultName);
  var teamHtml = teamHomeSectionHtml(tenant);

  // Header, hero, and footer stay fixed; everything between can be reordered or hidden.
  var sections = renderPageSections(tenant, 'home', [
    { id: 'featured', label: 'Featured', html: featuredHtml },
    { id: 'services', label: 'Services', html: servicesHtml },
    { id: 'shop', label: 'Shop', html: shopPreviewSection },
    { id: 'about', label: 'About', html: aboutHtml },
    { id: 'team', label: 'Team', html: teamHtml }
  ]);
  return '<div class="tattoo-page classic-home classic-home-page">' +
    nav + heroHtml + sections + footerHtml + galleryLightboxShellHtml() + sidebar +
    '</div>';
}

function tattooHeroPage(tenant, services) {
  return classicHomePage(tenant, services || [], {
    defaultName: 'Studio',
    industryLabel: 'Tattoo',
    bookLabel: 'Book now',
    galleryPlaceholder: 'Add your portfolio in the app.',
    featuredHeading: 'Fresh ink',
    featuredSub: 'A selection of recent work.',
    featuredEmpty: 'Your best work will appear here.',
    defaultBio: 'Quality ink, thoughtful design, and a clean studio experience.',
    aboutHeading: 'Quality ink, <em>every session.</em>'
  });
}

function hairTattooStyleHomePage(tenant, services) {
  return classicHomePage(tenant, services || [], {
    defaultName: 'Salon',
    industryLabel: 'Hair salon',
    bookLabel: 'Book now',
    galleryPlaceholder: 'Add transformation photos in the app.',
    featuredHeading: 'Recent looks',
    featuredSub: 'A selection of recent cuts, color, and styles.',
    featuredEmpty: 'Your best looks will appear here.',
    defaultBio: 'Expert techniques and premium products to give your hair the care it deserves.',
    aboutHeading: 'Beautiful hair, <em>every visit.</em>'
  });
}

function classicPortfolioHomePage(tenant, services) {
  var isNails = tenant.industry === 'nails';
  var isCharters = tenant.industry === 'charters';
  return classicHomePage(tenant, services || [], {
    defaultName: isNails ? 'Nail studio' : (isCharters ? 'Charters' : 'Studio'),
    industryLabel: isNails ? 'Nails' : (isCharters ? 'Charter' : ''),
    bookLabel: isCharters ? 'Book a trip' : 'Book now',
    galleryPlaceholder: isNails
      ? 'Add nail sets, art, and salon photos in the app.'
      : (isCharters ? 'Add boat, catch, and trip photos in the app.' : 'Add your best work in the app.'),
    featuredHeading: isNails ? 'Recent sets' : (isCharters ? 'On the water' : 'Featured work'),
    featuredSub: isNails
      ? 'Recent sets, color, and nail art.'
      : (isCharters ? 'Recent trips, catches, and days offshore.' : 'A selection of recent work from the studio.'),
    featuredEmpty: isNails
      ? 'Your best sets will appear here.'
      : (isCharters ? 'Your best trip photos will appear here.' : 'Your best work will appear here.'),
    defaultBio: isNails
      ? 'Polished details, beautiful finishes, and an elevated salon experience.'
      : (isCharters
        ? 'Private charters and fishing trips planned around your group and the day you want on the water.'
        : 'Professional service, thoughtful care, and a smooth booking experience.'),
    aboutHeading: isNails
      ? 'Polished details, <em>every set.</em>'
      : (isCharters ? 'Days that belong <em>on the water.</em>' : 'Quality work, <em>every time.</em>')
  });
}

function classicShopPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var nav = tattooNavHtml(tenant);
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
  var productCards = luxeTenantProductCardsHtml(tenant);
  var inner = productCards
    ? '<div class="luxe-shop-inner"><p class="classic-section-eyebrow">' + wcSpan(tenant, 'wc.classic.shopEyebrow', 'Retail') + '</p><h2 style="font-family:var(--font-display);font-size:1.6rem;font-weight:600;margin:0 0 8px">' + wcSpan(tenant, 'wc.classic.shopHeading', 'Shop') + '</h2><p style="color:#888;max-width:420px;margin:0 auto 12px;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.classic.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><div class="luxe-shop-grid">' + productCards + '</div></div>'
    : '<div class="luxe-shop-inner"><p class="classic-section-eyebrow">' + wcSpan(tenant, 'wc.classic.shopEyebrow', 'Retail') + '</p><h2 style="font-family:var(--font-display);font-size:1.6rem;font-weight:600;margin:0 0 8px">' + wcSpan(tenant, 'wc.classic.shopHeading', 'Shop') + '</h2><p style="color:#888;max-width:420px;margin:0 auto 12px;text-align:center;line-height:1.45">' + wcSpan(tenant, 'wc.classic.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><p class="gallery-empty-hint" style="color:#888;max-width:420px;margin:24px auto 0">No products yet. Check back soon.</p></div>';
  var shopWrapClass = 'tattoo-page classic-home' + (isStonecutTheme(tenant) ? ' tattoo-page--stonecut' : '');
  return '<div class="' + shopWrapClass + '">' + nav +
    '<div class="luxe-shop-page-shell" data-bk-color-surface="page"' +
    classicBkSurfaceKeyAttr(tenant, 'classic.shopPage') +
    ' data-bk-band-tappable style="padding-top:32px">' +
    bkColorBandInnerWrap(inner) + '</div>' +
    classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio')) + sidebar + '</div>';
}

function bindTattooSidebar() {
  bindBkFadeUp();
  var menuBtns = document.querySelectorAll('.tattoo-nav-menu');
  var sidebar = document.getElementById('tattoo-sidebar');
  if (!menuBtns.length || !sidebar) return;
  function setSidebarOpen(open) {
    sidebar.classList.toggle('tattoo-sidebar-open', !!open);
    for (var si = 0; si < menuBtns.length; si++) {
      menuBtns[si].setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }
  function toggleSidebar() {
    setSidebarOpen(!sidebar.classList.contains('tattoo-sidebar-open'));
  }
  function closeSidebar() {
    setSidebarOpen(false);
  }
  for (var mi = 0; mi < menuBtns.length; mi++) {
    menuBtns[mi].setAttribute('aria-expanded', 'false');
    menuBtns[mi].addEventListener('click', function(ev){
      ev.preventDefault();
      toggleSidebar();
    });
  }
  var backdrop = sidebar.querySelector('.tattoo-sidebar-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeSidebar);
  sidebar.querySelectorAll('.tattoo-sidebar-close').forEach(function(btn){
    btn.addEventListener('click', function(ev){
      ev.preventDefault();
      closeSidebar();
    });
  });
  sidebar.querySelectorAll('.tattoo-sidebar-panel a').forEach(function(a){
    a.addEventListener('click', closeSidebar);
  });
  document.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape') closeSidebar();
  });
}

function pageIsClassicTemplate() {
  var root = document.getElementById('root');
  if (!root) return false;
  if (root.querySelector('.studio12-page, .blade-page, .luxe-page, .stonecut-page')) return false;
  return !!root.querySelector('.classic-home');
}

function shouldClassicMobileTopCart() {
  return pageIsClassicTemplate() && classicMobileCartMq.matches;
}

function bindClassicMobileCartPlacement(cartBtn) {
  placeShopCartButton(cartBtn);
  if (bkShopCartPlacementListenerBound) return;
  bkShopCartPlacementListenerBound = true;
  function onClassicCartPlacementChange() {
    var btn = document.getElementById('bk-shop-nav-cart');
    if (btn && pageIsClassicTemplate()) placeShopCartButton(btn);
  }
  if (classicMobileCartMq.addEventListener) {
    classicMobileCartMq.addEventListener('change', onClassicCartPlacementChange);
  } else if (classicMobileCartMq.addListener) {
    classicMobileCartMq.addListener(onClassicCartPlacementChange);
  }
  window.addEventListener('resize', onClassicCartPlacementChange);
}

function tattooSidebarShellHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  return '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarBrandHtml(tenant, base) +
    sidebarLinksHtml(tenant, base, bookUrl) +
    '</div></div>';
}

function classicShopCheckoutPage(tenant) {
  return webShopCheckoutShell(tenant, 'tattoo-page classic-home', tattooNavHtml(tenant), classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio')), 'luxe-shop-page-shell');
}
