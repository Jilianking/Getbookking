/* Studio 12 template. */

/** Studio 12 keyed cards (services, info halves, booking form): readable ink on custom fills. */
function isStudio12KeyedCardKey(key) {
  if (!key) return false;
  if (key.indexOf('studio12.svcCard.') === 0) return true;
  if (key.indexOf('studio12.processStep.') === 0) return true;
  if (key.indexOf('studio12.homeTeamCard.') === 0) return true;
  if (key.indexOf('studio12.teamCard.') === 0) return true;
  if (key.indexOf('studio12.testimonialCard.') === 0) return true;
  return key === 'studio12.when' || key === 'studio12.bookCta' || key === 'studio12.where' ||
    key === 'studio12.map' || key === 'studio12.bookingCard' || key === 'studio12.testimonials' ||
    key === 'studio12.team';
}

function applyKeyedStudio12CardInk(el, key, bgCol) {
  if (!el || !bgCol || bgCol.charAt(0) !== '#') return;
  if (!isStudio12KeyedCardKey(key)) return;
  var fg = contrastingInkHex(bgCol);
  try { el.style.setProperty('color', fg, 'important'); }
  catch (e) { el.style.color = fg; }
  el.style.setProperty('--bk-fg', fg);
  el.style.setProperty('--bk-fg-muted', rgbaFromHex(fg, 0.58));
  if (key === 'studio12.bookingCard') {
    el.style.setProperty('--bk-input-bg', 'color-mix(in srgb, ' + fg + ' 7%, transparent)');
  } else {
    el.style.setProperty('--bk-accent', fg);
  }
}

function clearKeyedStudio12CardInk(el, key) {
  if (!el || !isStudio12KeyedCardKey(key)) return;
  el.style.removeProperty('color');
  el.style.removeProperty('--bk-fg');
  el.style.removeProperty('--bk-fg-muted');
  el.style.removeProperty('--bk-accent');
  if (key === 'studio12.bookingCard') el.style.removeProperty('--bk-input-bg');
}

/** Studio 12: empty image placeholders + unkeyed bands follow palette tokens. */
function applyStudio12HomeBandColors(tenant) {
  if (!isStudio12Theme(tenant)) return;
  var c = tenantColors(tenant);
  applyEmptyImageSlotColors(tenant);
  [].forEach.call(document.querySelectorAll('.studio12-page .s12-services, .studio12-page .s12-philosophy, .studio12-page .s12-process, .studio12-page .s12-testimonials'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.card;
    el.style.color = c.fg;
  });
  [].forEach.call(document.querySelectorAll('.studio12-page .s12-gallery-light'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.featuredBg || c.bg;
    el.style.color = c.featuredFg || c.fg;
  });
  [].forEach.call(document.querySelectorAll('.studio12-page .s12-info'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.aboutBg;
    el.style.color = c.aboutFg;
  });
  [].forEach.call(document.querySelectorAll('.studio12-page footer.s12-footer'), function(el) {
    if ((el.getAttribute('data-bk-surface-key') || '').trim()) return;
    el.style.background = c.aboutBg;
    el.style.color = c.aboutFg;
  });
}

/** Paint Studio 12 /book root + shell so `studio12.bookingPage` stays visible (nav stays `studio12.nav`). */
function applyStudio12BookingPageRootFill(col) {
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
  [].forEach.call(document.querySelectorAll('.studio12-page.studio12-sub:has(.booking-shell)'), function(root) {
    paint(root);
    [].forEach.call(root.querySelectorAll('.booking-shell'), paint);
    [].forEach.call(root.querySelectorAll('.booking-page-band'), paint);
  });
}

/** Studio 12-only per-band paint key (`webSurfaceColors`). */
function studio12BkSurfaceKeyAttr(tenant, key) {
  if (!tenant || !key) return '';
  if (!isStudio12Theme(tenant)) return '';
  return ' data-bk-surface-key="' + esc(key) + '"';
}

/** Studio 12 card/block paint target — role `card` plus a unique key so fills never share tokens. */
function studio12BkCardSurfaceAttrs(tenant, key) {
  if (!tenant || !key || !isStudio12Theme(tenant)) return '';
  return ' data-bk-color-surface="card"' + studio12BkSurfaceKeyAttr(tenant, key);
}

/** Studio 12 info/service cell — Blade-style band per keyed fill. */
function studio12KeyedCellBandHtml(tenant, surfaceKey, className, innerHtml, extraAttrs) {
  var cls = className || 's12-info-half';
  var extra = extraAttrs || '';
  if (!tenant || !surfaceKey || !isStudio12Theme(tenant)) {
    return '<div class="' + cls + ' s12-fade"' + extra + '>' + innerHtml + '</div>';
  }
  return '<div class="' + cls + ' s12-fade" data-bk-color-surface="card"' +
    studio12BkSurfaceKeyAttr(tenant, surfaceKey) + ' data-bk-band-tappable' + extra + '>' +
    bkColorBandHitButtonHtml() +
    '<div class="bk-band-content">' + innerHtml + '</div></div>';
}

/** Studio 12 info headings: editable lead + clay italic word (two `wc.*` keys). */
function s12InfoTitleHtml(tenant, leadKey, leadDefault, emKey, emDefault) {
  return '<h3 class="s12-info-title">' + wcSpan(tenant, leadKey, leadDefault) + ' <em style="' + s12ClayEmStyle + '">' +
    wcSpan(tenant, emKey, emDefault) + '</em></h3>';
}

function studio12NavLogoSubHtml(tenant) {
  var tagline = (tenant.tagline || '').trim();
  var area = (tenant.serviceArea || '').trim();
  var inner = '';
  if (tagline) {
    inner = wcSpan(tenant, 'wc.s12.navSub', tagline);
  } else if (area) {
    inner = wcSpan(tenant, 'wc.contact.serviceArea', area);
  } else {
    inner = wcSpan(tenant, 'wc.s12.navSub', 'Hair studio');
  }
  return '<span class="s12-nav-logo-sub">' + inner + '</span>';
}

function s12ProcessSpan(stepIndex, field, displayText) {
  var inner = field === 'body' ? esc(displayText).replace(/\n/g, '<br>') : esc(displayText);
  return '<span data-edit-key="s12Process:' + stepIndex + ':' + field + '">' + inner + '</span>';
}

/** Whole process cell tap → native Edit step sheet (`s12Process:<n>:edit`). */
function s12ProcessEditAttr(stepIndex) {
  return ' data-edit-key="s12Process:' + stepIndex + ':edit" role="button" aria-label="Edit step"';
}

function studio12MapCaptureImageUrl(tenant) {
  var captureSrc = tenant && tenant.mapCaptureImageUrl ? String(tenant.mapCaptureImageUrl).trim() : '';
  if (!captureSrc) return '';
  if (/^https?:\/\//i.test(captureSrc)) return captureSrc;
  if (captureSrc.charAt(0) === '/') {
    /* Tenant subdomains (*.getbookking.com) route /assets/* to the SPA; use hosting root. */
    return 'https://test-app-96812.web.app' + captureSrc;
  }
  return captureSrc;
}

function studio12MapEmbedHtml(tenant, addrTrim) {
  if (!addrTrim) return '';
  var mapsLink = googleMapsSearchUrl(addrTrim);
  if (isBkCaptureMode()) {
    var captureSrc = studio12MapCaptureImageUrl(tenant);
    if (captureSrc) {
      return '<a class="s12-map-static-link" href="' + esc(mapsLink) + '" target="_blank" rel="noopener noreferrer">' +
        '<img src="' + esc(captureSrc) + '" alt="Studio location map" loading="eager" /></a>';
    }
  }
  return '<iframe src="' + esc(googleMapsEmbedUrl(addrTrim)) + '" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Studio location"></iframe>';
}

/** Studio 12 hours: structured grid from weekly schedule, else plain text fallback. */
function studio12HoursBlockHtml(tenant) {
  var rows = businessHoursWeeklyGroupedRows(tenant);
  if (rows && rows.length) {
    var inner = rows.map(function(row) {
      var timeClass = row.closed ? ' s12-hours-time--closed' : '';
      return '<div class="s12-hours-row">' +
        '<span class="s12-hours-day">' + esc(row.label) + '</span>' +
        '<span class="s12-hours-time' + timeClass + '">' + esc(row.time) + '</span></div>';
    }).join('');
    return '<div class="s12-hours-block s12-hours-block--grid">' + inner + '</div>';
  }
  var hoursTrim = tenantBusinessHoursTrimmed(tenant);
  if (hoursTrim) {
    return '<div class="s12-hours-block">' + esc(hoursTrim).replace(/\n/g, '<br>') + '</div>';
  }
  return '<p class="s12-phil-body">' + wcSpan(tenant, 'wc.contact.hours', 'Add business hours in the app.') + '</p>';
}

function isStudio12Theme(tenant) {
  return tenant && tenant.resolvedWebThemeId === 'studio-12-v1';
}

function studio12SidebarHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  return '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>';
}

/** Studio 12: brand, optional Instagram, then © line. */
function studio12SiteFooterHtml(tenant) {
  var ig = tenant.instagramHandle ? String(tenant.instagramHandle).replace(/^@/, '') : '';
  var igUrl = ig ? ('https://instagram.com/' + encodeURIComponent(ig)) : '';
  var linksHtml = igUrl
    ? ('<div class="s12-footer-links"><a href="' + esc(igUrl) + '" target="_blank" rel="noopener noreferrer"><span data-edit-key="wc.contact.instagram">@' +
      esc(webCopyOverrideText(tenant, 'wc.contact.instagram', ig)) + '</span></a></div>')
    : '';
  return '<footer class="s12-footer" data-bk-color-surface="about"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.footer') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="s12-footer-brand">' + siteNameSpan(tenant, 'Studio') + '</div>' +
    linksHtml +
    '<p class="s12-footer-copy">' + footerLegalLineHtml(tenant) + '</p>') +
    '</footer>';
}

/** Infinite horizontal gallery strip; duplicates items for seamless loop. `imageCount` sets data-gallery-count and animation speed. */
function studio12GalleryMarqueeHtml(gItems, imageCount) {
  var n = typeof imageCount === 'number' && imageCount > 0 ? imageCount : 1;
  var capped = Math.min(n, 16);
  var dur = Math.min(96, 24 + capped * 9);
  var dataCount = Math.min(Math.max(capped, 1), 12);
  return '<div class="s12-gallery-marquee" data-gallery-count="' + dataCount + '">' +
    '<div class="s12-gallery-marquee-inner" style="animation-duration:' + dur + 's">' +
    '<div class="s12-gallery-marquee-chunk">' + gItems + '</div>' +
    '<div class="s12-gallery-marquee-chunk" aria-hidden="true">' + gItems + '</div>' +
    '</div></div>';
}

function studio12NavHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var homeUrl = base + '/home';
  var displayName = tenantSiteDisplayName(tenant, 'Studio');
  var navLis = '<li><a href="' + homeUrl + '">' + wcSpan(tenant, 'wc.s12.navHome', 'Home') + '</a></li>';
  if (tenantShowGalleryPage(tenant)) navLis += '<li><a href="' + galleryUrl + '">' + wcSpan(tenant, 'wc.s12.navGallery', 'Gallery') + '</a></li>';
  if (tenantShowTeamPage(tenant)) navLis += '<li><a href="' + base + '/team">' + wcSpan(tenant, 'wc.s12.navTeam', 'Team') + '</a></li>';
  if (tenantShowShopPage(tenant)) navLis += '<li><a href="' + base + '/shop">' + wcSpan(tenant, 'wc.s12.navShop', 'Shop') + '</a></li>';
  var navBookLbl = webCopyOverrideText(tenant, 'wc.s12.navBook', 'Book now');
  var bookCorner = tenantShowBookPage(tenant)
    ? '<a class="s12-nav-book" href="' + bookUrl + '" data-cta-key="wc.s12.navBook">' + esc(navBookLbl) + '</a>'
    : '';
  return '<nav class="s12-topnav" id="s12-nav" data-bk-color-surface="page"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.nav') + '>' +
    '<button type="button" class="tattoo-nav-menu" aria-label="Menu">' + hamburgerMenuSvg() + '</button>' +
    '<a href="' + homeUrl + '" class="s12-nav-logo">' +
    '<span class="s12-nav-logo-main">' + siteNameSpan(tenant, 'Studio', 'displayName.s12.nav') + '</span>' +
    studio12NavLogoSubHtml(tenant) + '</a>' +
    '<ul class="s12-nav-links">' + navLis + '</ul>' +
    '<div class="s12-nav-trailing">' +
    bookCorner +
    '</div></nav>';
}

function studio12ScrollToServices() {
  var sec = document.getElementById('s12-services');
  if (!sec) return;
  var nav = document.getElementById('s12-nav');
  var offset = nav ? nav.offsetHeight + 12 : 80;
  var top = sec.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function studio12HashTargetsServices() {
  return (location.hash || '').toLowerCase() === '#s12-services';
}

function bindStudio12Page() {
  var nav = document.getElementById('s12-nav');
  if (nav) {
    function onS12NavScroll() {
      var activeNav = document.getElementById('s12-nav');
      if (!activeNav) return;
      activeNav.classList.toggle('scrolled', window.scrollY > 50);
    }
    onS12NavScroll();
    if (!window.__s12NavScrollBound) {
      window.__s12NavScrollBound = true;
      window.addEventListener('scroll', onS12NavScroll, { passive: true });
    }
  }
  var page = document.querySelector('.studio12-page');
  if (page && !page.dataset.s12ServicesScrollBound) {
    page.dataset.s12ServicesScrollBound = '1';
    page.addEventListener('click', function(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = (a.getAttribute('href') || '').trim();
      if (href.indexOf('#s12-services') < 0) return;
      if (!document.getElementById('s12-services')) return;
      e.preventDefault();
      if (href.charAt(0) === '#') {
        history.replaceState(null, '', href);
      } else {
        try {
          var linkUrl = new URL(href, location.href);
          history.replaceState(null, '', linkUrl.pathname + linkUrl.search + linkUrl.hash);
        } catch (err) {
          history.replaceState(null, '', '#s12-services');
        }
      }
      studio12ScrollToServices();
    });
  }
  var fades = document.querySelectorAll('.studio12-page .s12-fade');
  if (!window.IntersectionObserver) {
    for (var i = 0; i < fades.length; i++) fades[i].classList.add('s12-visible');
    return;
  }
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(en) {
      if (en.isIntersecting) {
        en.target.classList.add('s12-visible');
        obs.unobserve(en.target);
      }
    });
  }, { threshold: 0.07 });
  for (var j = 0; j < fades.length; j++) obs.observe(fades[j]);
}

function studio12HomeShopSectionHtml(tenant) {
  if (!tenantShouldBindShopCart(tenant)) return '';
  var cards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'studio12.homeProduct.' });
  if (!cards) return '';
  var base = tenantBaseUrl(tenant);
  return '<section class="s12-services s12-shop-home" id="shop" data-bk-color-surface="card"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.shop') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap(
    '<div class="s12-section-label">' + wcSpan(tenant, 'wc.s12.shopSectionLabel', 'Retail') + '</div>' +
    '<h2 class="s12-section-title">' + wcSpan(tenant, 'wc.s12.shopTitleLead', 'Shop') + '<em>' + wcSpan(tenant, 'wc.s12.shopTitleEm', '') + '</em></h2>' +
    '<p style="text-align:center;color:#888;max-width:420px;margin:0 auto;line-height:1.45">' + wcSpan(tenant, 'wc.s12.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p>' +
    '<div class="luxe-shop-grid" style="max-width:960px;margin:0 auto">' + cards + '</div>' +
    '<p style="text-align:center;margin-top:28px"><a class="s12-btn-outline" href="' + base + '/shop" data-cta-key="wc.s12.shopViewAll">' + wcSpan(tenant, 'wc.s12.shopViewAll', 'View full shop') + '</a></p>') +
    '</section>';
}

function studio12ShopPage(tenant) {
  var cards = luxeTenantProductCardsHtml(tenant, { surfaceKeyPrefix: 'studio12.shopProduct.' });
  var inner = cards
    ? '<div class="s12-section-label">' + wcSpan(tenant, 'wc.s12.shopSectionLabel', 'Retail') + '</div><h2 class="s12-section-title">' + wcSpan(tenant, 'wc.s12.shopTitleLead', 'Shop') + '<em>' + wcSpan(tenant, 'wc.s12.shopTitleEm', '') + '</em></h2><p style="text-align:center;color:#888;max-width:420px;margin:0 auto;line-height:1.45">' + wcSpan(tenant, 'wc.s12.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><div class="luxe-shop-grid" style="max-width:960px;margin:0 auto">' + cards + '</div>'
    : '<div class="s12-section-label">' + wcSpan(tenant, 'wc.s12.shopSectionLabel', 'Retail') + '</div><h2 class="s12-section-title">' + wcSpan(tenant, 'wc.s12.shopTitleLead', 'Shop') + '<em>' + wcSpan(tenant, 'wc.s12.shopTitleEm', '') + '</em></h2><p style="text-align:center;color:#888;max-width:420px;margin:0 auto;line-height:1.45">' + wcSpan(tenant, 'wc.s12.shopLead', 'Studio retail, curated for clients—see everything on the full shop.') + '</p><p class="s12-phil-body" style="text-align:center;margin-top:18px">No products yet. Add them in the app.</p>';
  var main = '<main class="s12-shop-shell" data-bk-color-surface="page"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.shopPage') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap(inner) + '</main>';
  return '<div class="studio12-page studio12-sub">' + studio12NavHtml(tenant) + main + studio12SiteFooterHtml(tenant) + studio12SidebarHtml(tenant) + '</div>';
}

function studio12IndustryKey(tenant) {
  var ind = String(tenant.industry || 'custom').toLowerCase();
  if (ind === 'hair' || ind === 'barber' || ind === 'tattoos' || ind === 'nails' || ind === 'charters') return ind;
  return 'custom';
}

/** Split on ` · ` into exactly `count` segments (extra dots merge into the last segment). */
function studio12SplitMiddleDot(raw, count) {
  var s = String(raw || '').trim();
  if (!s) {
    var empty = [];
    for (var z = 0; z < count; z++) empty.push('');
    return empty;
  }
  var parts = s.split(STUDIO12_MIDDLE_DOT_SEP).map(function(p) { return p.trim(); });
  while (parts.length < count) parts.push('');
  if (parts.length > count) {
    var tail = parts.slice(count - 1).join(STUDIO12_MIDDLE_DOT_SEP);
    parts = parts.slice(0, count - 1).concat([tail]);
  }
  return parts;
}

/** Prefer break after “… that …”; else split on a space near the middle. */
function studio12SplitHeroHeadline(raw) {
  var s = String(raw || '').trim();
  if (!s) return { line1: '', line2: '' };
  var m = s.match(/^(.+?)\s+that\s+(.+)$/i);
  if (m) {
    return { line1: (m[1].trim() + ' that'), line2: m[2].trim() };
  }
  var mid = Math.floor(s.length / 2);
  var left = s.lastIndexOf(' ', mid);
  var right = s.indexOf(' ', mid);
  var breakAt = -1;
  if (left < 0) breakAt = right;
  else if (right < 0) breakAt = left;
  else breakAt = (mid - left <= right - mid) ? left : right;
  if (breakAt <= 0 || breakAt >= s.length - 1) {
    return { line1: s, line2: '' };
  }
  return { line1: s.slice(0, breakAt).trim(), line2: s.slice(breakAt + 1).trim() };
}

/** Defaults per business type — keep in sync with Studio12IndustryCopy.swift */
function studio12IndustryBundle(tenant) {
  var k = studio12IndustryKey(tenant);
  var bookBodyStd = "Book online in minutes. We'll confirm your slot and follow up with everything you need.";
  var bookBodyTat = "Book online to start your request. We'll confirm timing and follow up with next steps.";
  var B = {
    hair: {
      heroEyebrow: 'Colour · Cut · Care', heroLine1: 'Hair that', heroLine2: 'reflects', heroItalicDefault: 'story.',
      heroLeadDefault: 'A boutique studio dedicated to the art of hair — bespoke colour, precision cuts, and restorative care.',
      phil1: 'Hair is more than', phil2: 'style.', philEm: "It's you.",
      philBody2Default: 'Every visit is intentional — from consultation to finish.',
      marquee: ['Colour', 'Cut', 'Care', 'Balayage', 'Styling'],
      bookL1: 'Ready for your', bookEm: 'next look?', bookBody: bookBodyStd,
      process: [
        { title: 'Book online', body: "Choose your service and send a request. We'll confirm your appointment." },
        { title: 'Consultation', body: 'We listen to your goals and recommend the right approach.' },
        { title: 'The service', body: 'Expert care in a calm, welcoming environment.' },
        { title: 'Aftercare', body: 'Tips and product guidance so your look lasts.' }
      ]
    },
    barber: {
      heroEyebrow: 'Cuts · Fades · Detail', heroLine1: 'Cuts that', heroLine2: 'define', heroItalicDefault: 'you.',
      heroLeadDefault: 'Sharp fades, clean lines, and consistent results — every chair, every visit.',
      phil1: 'Precision is more than', phil2: 'a fade.', philEm: "It's confidence.",
      philBody2Default: 'From consultation to final detail — we keep your style consistent.',
      marquee: ['Fades', 'Tapers', 'Beard Work', 'Lineups', 'Detail'],
      bookL1: 'Ready for your', bookEm: 'next cut?', bookBody: bookBodyStd,
      process: [
        { title: 'Book online', body: "Choose your service and send a request. We'll confirm your appointment." },
        { title: 'Consultation', body: 'We align on style, length, and the details that matter to you.' },
        { title: 'The cut', body: 'Clean execution with attention to line, blend, and finish.' },
        { title: 'Aftercare', body: 'Product tips and timing so your cut stays sharp.' }
      ]
    },
    tattoos: {
      heroEyebrow: 'Design · Ink · Detail', heroLine1: 'Ink that', heroLine2: 'tells', heroItalicDefault: 'your story.',
      heroLeadDefault: 'Custom work, clean execution, and a calm studio experience from idea to healed piece.',
      phil1: 'Art is more than', phil2: 'ink on skin.', philEm: "It's permanence with intention.",
      philBody2Default: 'We collaborate on design, placement, and pacing so your piece ages beautifully.',
      marquee: ['Custom', 'Fine line', 'Blackwork', 'Color', 'Flash'],
      bookL1: 'Ready for your', bookEm: 'next piece?', bookBody: bookBodyTat,
      process: [
        { title: 'Book online', body: "Send a request with timing and ideas. We'll follow up to plan next steps." },
        { title: 'Design', body: 'We refine placement, size, and style before your appointment.' },
        { title: 'The session', body: 'Professional application in a clean, focused environment.' },
        { title: 'Healing', body: 'Aftercare guidance so your tattoo heals clean and stays bold.' }
      ]
    },
    nails: {
      heroEyebrow: 'Color · Care · Finish', heroLine1: 'Nails that', heroLine2: 'elevate', heroItalicDefault: 'every day.',
      heroLeadDefault: 'Clean finishes, thoughtful details, and sets built to last — book your next appointment.',
      phil1: 'Polish is more than', phil2: 'color.', philEm: "It's the details.",
      philBody2Default: 'Hygiene-first care and precision application for a finish you can count on.',
      marquee: ['Manicure', 'Gel', 'Pedicure', 'Nail Art', 'Care'],
      bookL1: 'Ready for your', bookEm: 'next set?', bookBody: bookBodyStd,
      process: [
        { title: 'Book online', body: "Choose your service and send a request. We'll confirm your appointment." },
        { title: 'Consultation', body: 'We confirm shape, length, color, and any nail-art details.' },
        { title: 'The service', body: 'Careful prep and application for a clean, lasting finish.' },
        { title: 'Aftercare', body: 'Home care tips so your set stays fresh longer.' }
      ]
    },
    charters: {
      heroEyebrow: 'Boat · Fish · Explore', heroLine1: 'Days that', heroLine2: 'belong', heroItalicDefault: 'on the water.',
      heroLeadDefault: 'Private charters and fishing trips planned around your group, the conditions, and the day you want on the water.',
      phil1: 'A charter is more than', phil2: 'a boat ride.', philEm: "It's the day you remember.",
      philBody2Default: 'From dock to open water — clear communication and a trip built for your crew.',
      marquee: ['Half-day', 'Full-day', 'Sunset', 'Fishing', 'Private'],
      bookL1: 'Ready for your', bookEm: 'next trip?', bookBody: bookBodyStd,
      process: [
        { title: 'Book online', body: "Choose your trip and send a request. We'll confirm availability and details." },
        { title: 'Plan the trip', body: 'We align on party size, timing, and fishing or cruise goals.' },
        { title: 'Cast off', body: 'Meet at the dock — gear guidance and a day built around your group.' },
        { title: 'After the trip', body: 'Photos, tips, and easy rebooking for your next day on the water.' }
      ]
    },
    custom: {
      heroEyebrow: 'Book · Visit · Connect', heroLine1: 'Work that', heroLine2: 'reflects', heroItalicDefault: 'you.',
      heroLeadDefault: 'Professional service, thoughtful communication, and a smooth booking experience.',
      phil1: 'Quality is more than', phil2: 'a checklist.', philEm: "It's consistency.",
      philBody2Default: 'Every step is intentional — from first message to finished result.',
      marquee: ['Consultation', 'Service', 'Follow-up', 'Booking', 'Care'],
      bookL1: 'Ready to', bookEm: 'book?', bookBody: bookBodyStd,
      process: [
        { title: 'Book online', body: "Choose your service and send a request. We'll confirm your appointment." },
        { title: 'Consultation', body: 'We clarify scope, timing, and what to expect.' },
        { title: 'The service', body: 'Focused work with clear communication throughout.' },
        { title: 'Follow-up', body: 'Clear next steps and guidance after your appointment.' }
      ]
    }
  };
  return B[k] || B.custom;
}

function studio12HomePage(tenant, services) {
  var s12 = studio12IndustryBundle(tenant);
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var homeUrl = base + '/home';
  var displayName = tenantSiteDisplayName(tenant, 'Studio');
  var showServicesSection = tenant.studio12ShowServicesSection !== false;
  var showProcessSection = tenant.studio12ShowProcessSection !== false;
  var exploreHref = showServicesSection ? '#s12-services' : (tenantShowBookPage(tenant) ? bookUrl : homeUrl);
  var exploreLabel = showServicesSection ? 'Explore services' : (tenantShowBookPage(tenant) ? 'Book now' : 'Home');
  var svcList = services || [];
  var marqueeNames = svcList.length
    ? svcList.map(function(s) { return s.name; })
    : s12.marquee;
  var marqueeDup = marqueeNames.concat(marqueeNames);
  var marqueeHtml = marqueeDup.map(function(n) {
    return '<span class="s12-marquee-item">' + esc(n) + '</span>';
  }).join('');
  var heroImg = tenant.heroImageUrl
    ? '<img class="s12-hero-img" data-edit-key="heroImage" src="' + esc(tenant.heroImageUrl) + '" alt="">'
    : '<div class="s12-hero-img-fallback" data-edit-key="heroImage" role="button" aria-label="Add hero image"></div>';
  var s12HeroColStyle = '';
  var heroItalic = tenantSiteTextOrCompute(tenant, 'heroTagline', function() {
    if (tenant.heroSubtitle && String(tenant.heroSubtitle).trim() && !isSiteTextBlankValue(tenant.heroSubtitle)) {
      return String(tenant.heroSubtitle).trim();
    }
    return s12.heroItalicDefault;
  });
  var heroLead = tenant.tagline || (tenant.aboutText ? String(tenant.aboutText).slice(0, 200) : '') ||
    s12.heroLeadDefault;
  var aboutFull = (tenant.aboutText || '').trim();
  var philParas = aboutFull ? aboutFull.split(/\n\n+/) : [];
  var philBody1 = philParas[0] || heroLead;
  var philBody2 = philParas[1] || s12.philBody2Default;
  var svcCells = '';
  if (showServicesSection) {
    for (var si = 0; si < svcList.length; si++) {
      var s = svcList[si];
      var dur = s.durationMinutes ? (s.durationMinutes + ' min') : '';
      var price = s.price != null && s.price > 0 ? ('$' + Math.round(s.price)) : '—';
      var desc = (s.description && String(s.description).trim()) ? String(s.description).trim() : 'Professional service tailored to you.';
      var sid12 = s.id ? String(s.id) : '';
      var svcCardKey = sid12 ? ('studio12.svcCard.' + sid12) : ('studio12.svcCard.i' + si);
      var svcCellInner = '<div><h3 class="s12-svc-name">' + svcSpan(tenant, sid12, 'name', s.name || 'Service') + '</h3>' +
        '<p class="s12-svc-meta">' + svcSpanMultiline(tenant, sid12, 'description', desc) + '</p>' +
        (dur ? '<div class="s12-svc-dur">' + svcSpan(tenant, sid12, 'duration', dur) + '</div>' : '') + '</div>' +
        '<div class="s12-svc-price">' + svcSpan(tenant, sid12, 'price', String(price)) + '</div>';
      svcCells += studio12KeyedCellBandHtml(tenant, svcCardKey, 's12-svc-cell', svcCellInner, svcEditAttr(sid12));
    }
    if (!svcCells) {
      svcCells = studio12KeyedCellBandHtml(tenant, 'studio12.svcCard.empty', 's12-svc-cell',
        '<div><h3 class="s12-svc-name">' + wcSpan(tenant, 'wc.s12.servicesEmptyTitle', 'Services') + '</h3>' +
        '<p class="s12-svc-meta">' + wcSpan(tenant, 'wc.s12.servicesEmptyHint', 'Add services in the Get Bookking app.') + '</p></div><div class="s12-svc-price">—</div>');
    }
  }
  var gUrls = galleryPageImageUrls(tenant);
  var gItems = gUrls.map(function(u, gi) {
    return '<div class="s12-g-item s12-fade">' +
      galleryLightboxTriggerHtml(u, {
        className: 's12-gallery-full-link',
        editAttr: galleryImageEditKeyAttr(gi)
      }) + '</div>';
  }).join('');
  if (!gItems) {
    gItems = '<div class="s12-g-item s12-fade"><div class="s12-hero-img-fallback"' + galleryImageEditKeyAttr(0) + ' style="min-height:280px"></div></div>';
  }
  var revs = tenant.reviews || [];
  var testCards = '';
  for (var ri = 0; ri < Math.min(revs.length, 3); ri++) {
    var rv = revs[ri] || {};
    var testInner = '<p class="s12-test-text">“' + esc(rv.quote || '') + '”</p>' +
      '<div class="s12-test-author">— ' + esc(rv.name || 'Client') +
      (rv.service ? (' · ' + esc(rv.service)) : '') + '</div>';
    testCards += studio12KeyedCellBandHtml(tenant, 'studio12.testimonialCard.' + ri, 's12-test-card', testInner);
  }
  var testSection = testCards
    ? '<section class="s12-testimonials" data-bk-color-surface="card"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.testimonials') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="s12-phil-label s12-fade">' + wcSpan(tenant, 'wc.s12.testimonialsLabel', 'Client love') + '</div>' +
      '<h2 class="s12-test-title s12-fade">' + wcSpan(tenant, 'wc.s12.testimonialsTitleLead', 'Words from') + ' <em>' + wcSpan(tenant, 'wc.s12.testimonialsTitleEm', 'our clients') + '</em></h2>' +
      '<div class="s12-test-grid">' + testCards + '</div>') + '</section>'
    : '';
  var hoursHtml = '';
  if (tenantShowBusinessHours(tenant)) {
    hoursHtml = studio12HoursBlockHtml(tenant);
  }
  var s12InfoClass = 's12-info' + (!tenantShowBusinessHours(tenant) ? ' s12-info--when-hidden' : '');
  var s12InfoInnerClass = 's12-info-inner' +
    (!tenantShowBusinessHours(tenant) ? ' s12-info-inner--no-hours' : '') +
    (!tenantShowBookPage(tenant) ? ' s12-info-inner--no-book' : '');
  var s12HoursHalf = tenantShowBusinessHours(tenant)
    ? studio12KeyedCellBandHtml(tenant, 'studio12.when', 's12-info-half s12-info-hours',
      '<div class="s12-phil-label">' + wcSpan(tenant, 'wc.s12.hoursLabel', 'Studio hours') + '</div>' +
      s12InfoTitleHtml(tenant, 'wc.s12.hoursTitleLead', 'When to', 'wc.s12.hoursTitleEm', 'visit') + hoursHtml)
    : '';
  var addrTrim = tenantStreetAddressText(tenant)
    || (tenant.serviceArea && String(tenant.serviceArea).trim() ? String(tenant.serviceArea).trim() : '');
  var addrMapsS12 = addrTrim ? googleMapsSearchUrl(addrTrim) : '';
  var addrHtml = addrTrim
    ? (addrMapsS12
      ? '<a class="s12-address s12-address-link" href="' + esc(addrMapsS12) + '" target="_blank" rel="noopener noreferrer">' + wcSpanMultiline(tenant, 'wc.contact.location', addrTrim) + '</a>'
      : '<div class="s12-address">' + wcSpanMultiline(tenant, 'wc.contact.location', addrTrim) + '</div>')
    : '';
  var phoneDispS12 = tenant.contactPhone ? displayPhoneUS(tenant.contactPhone) : '';
  var phoneHrefS12 = telHrefFromPhone(tenant.contactPhone);
  var phoneEl = '';
  if (phoneDispS12) {
    if (phoneHrefS12) {
      phoneEl = '<a class="s12-phone" href="' + esc(phoneHrefS12) + '">' + wcSpan(tenant, 'wc.contact.phone', phoneDispS12) + '</a>';
    } else {
      phoneEl = '<div class="s12-phone">' + wcSpan(tenant, 'wc.contact.phone', phoneDispS12) + '</div>';
    }
  }
  var mapEmbedHtml = addrTrim ? studio12MapEmbedHtml(tenant, addrTrim) : '';
  var studioContactInner = '<div class="s12-phil-label">' + wcSpan(tenant, 'wc.s12.findUsLabel', 'Find us') + '</div>' +
    s12InfoTitleHtml(tenant, 'wc.s12.studioTitleLead', 'The', 'wc.s12.studioTitleEm', 'studio') +
    addrHtml + phoneEl;
  var s12StudioHalf = studio12KeyedCellBandHtml(tenant, 'studio12.where', 's12-info-half s12-info-studio', studioContactInner);
  var s12MapHalf = mapEmbedHtml
    ? studio12KeyedCellBandHtml(tenant, 'studio12.map', 's12-info-half s12-info-map',
      '<div class="s12-map-embed">' + mapEmbedHtml + '</div>')
    : studio12KeyedCellBandHtml(tenant, 'studio12.map', 's12-info-half s12-info-map', '', ' aria-hidden="true"');
  var ig = tenant.instagramHandle ? String(tenant.instagramHandle).replace(/^@/, '') : '';
  var igLink = ig ? ('https://instagram.com/' + encodeURIComponent(ig)) : '';
  var phMerged = (tenant.studio12PhilosophyHeadline || '').trim();
  var phL1, phL2, phEm;
  if (phMerged) {
    var pp = studio12SplitMiddleDot(phMerged, 3);
    phL1 = pp[0];
    phL2 = pp[1];
    phEm = pp[2];
  } else {
    phL1 = tenantSiteTextOrCompute(tenant, 'studio12PhilosophyHeadLine1', s12.phil1);
    phL2 = tenantSiteTextOrCompute(tenant, 'studio12PhilosophyHeadLine2', s12.phil2);
    phEm = tenantSiteTextOrCompute(tenant, 'studio12PhilosophyHeadItalic', s12.philEm);
  }
  var philTitleHtml = '<h2 class="s12-phil-title">' + siteTextSpan('studio12PhilosophyHeadLine1', phL1) + '<br>' +
    siteTextSpan('studio12PhilosophyHeadLine2', phL2) + '<br><em>' + siteTextSpan('studio12PhilosophyHeadItalic', phEm) + '</em></h2>';
  var philImgCol = tenant.studio12PhilosophyImageUrl
    ? ('<div class="s12-aux-img-wrap">' +
      '<img class="s12-hero-img" data-edit-key="studio12PhilosophyImage" src="' + esc(tenant.studio12PhilosophyImageUrl) + '" alt=""></div>')
    : '<div class="s12-hero-img-fallback" data-edit-key="studio12PhilosophyImage" role="button" aria-label="Add philosophy image" style="min-height:360px;border-radius:2px"></div>';
  var defaultProc = s12.process;
  var procSrc = (Array.isArray(tenant.studio12ProcessSteps) && tenant.studio12ProcessSteps.length)
    ? tenant.studio12ProcessSteps : defaultProc;
  var procCount = procSrc.length > 0 ? procSrc.length : defaultProc.length;
  procCount = Math.min(Math.max(procCount, 1), 12);
  var procCells = '';
  if (showProcessSection) {
    for (var pi = 0; pi < procCount; pi++) {
      var step = procSrc[pi];
      var defI = Math.min(pi, defaultProc.length - 1);
      var fallback = defaultProc[defI] || defaultProc[0];
      if (!step) step = fallback;
      var num = pi < 9 ? ('0' + (pi + 1)).slice(-2) : String(pi + 1);
      var st = (step && step.title) ? String(step.title) : fallback.title;
      var sb = (step && (step.body != null || step.description != null))
        ? String(step.body != null ? step.body : step.description) : fallback.body;
      var procCellInner = '<div class="s12-step-num">' + wcSpan(tenant, 'wc.s12.step' + pi + '.n', num) + '</div>' +
        '<h3 class="s12-step-title">' + s12ProcessSpan(pi, 'title', st) + '</h3>' +
        '<p class="s12-step-desc">' + s12ProcessSpan(pi, 'body', sb) + '</p>';
      procCells += studio12KeyedCellBandHtml(tenant, 'studio12.processStep.' + pi, 's12-process-cell', procCellInner, s12ProcessEditAttr(pi));
    }
  }
  var servicesSectionHtml = showServicesSection
    ? '<section class="s12-services" id="s12-services" data-bk-color-surface="card"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.services') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="s12-section-label s12-fade">' + wcSpan(tenant, 'wc.s12.servicesEyebrow', 'What we offer') + '</div>' +
      '<h2 class="s12-section-title s12-fade">' + wcSpan(tenant, 'wc.s12.servicesTitleLead', 'Our') + ' <em>' + wcSpan(tenant, 'wc.s12.servicesEm', 'services') + '</em></h2>' +
      '<div class="s12-svc-grid">' + svcCells + '</div>') + '</section>'
    : '';
  var processSectionHtml = showProcessSection
    ? '<section class="s12-process" data-bk-color-surface="card"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.process') + ' data-bk-band-tappable>' +
      bkColorBandInnerWrap('<div class="s12-section-label s12-fade">' + wcSpan(tenant, 'wc.s12.processLabel', 'How it works') + '</div>' +
      '<h2 class="s12-section-title s12-fade" style="margin-bottom:48px">' + wcSpan(tenant, 'wc.s12.processTitleLead', 'Your') + ' <em>' + wcSpan(tenant, 'wc.s12.processTitleEm', 'experience') + '</em></h2>' +
      '<div class="s12-process-grid">' + procCells + '</div>') + '</section>'
    : '';
  var bcHeadMerged = (tenant.studio12BookCtaHeadline || '').trim();
  var bcL1, bcEm;
  if (bcHeadMerged) {
    var bp = studio12SplitMiddleDot(bcHeadMerged, 2);
    bcL1 = bp[0];
    bcEm = bp[1];
  } else {
    bcL1 = tenantSiteTextOrCompute(tenant, 'studio12BookCtaLine1', s12.bookL1);
    bcEm = tenantSiteTextOrCompute(tenant, 'studio12BookCtaItalic', s12.bookEm);
  }
  var bcBody = tenantSiteTextOrCompute(tenant, 'studio12BookCtaBody', s12.bookBody);
  var s12BookGridImg = tenant.studio12BookCtaImageUrl
    ? ('<div class="s12-aux-img-wrap s12-info-book-img-wrap">' +
      '<img class="s12-hero-img" data-edit-key="studio12BookCtaImage" src="' + esc(tenant.studio12BookCtaImageUrl) + '" alt=""></div>')
    : ('<div class="s12-info-book-img-fallback s12-info-book-img-fallback--empty" data-edit-key="studio12BookCtaImage" role="button" aria-label="Add booking section image"></div>');
  var s12BookGridHalf = tenantShowBookPage(tenant)
    ? studio12KeyedCellBandHtml(tenant, 'studio12.bookCta', 's12-info-half s12-info-book',
      '<div class="s12-phil-label">' + wcSpan(tenant, 'wc.s12.bookSectionLabel', 'Reserve') + '</div>' +
      '<h2 class="s12-info-book-title">' + siteTextSpan('studio12BookCtaLine1', bcL1) + '<br><em>' + siteTextSpan('studio12BookCtaItalic', bcEm) + '</em></h2>' +
      '<p class="s12-info-book-body">' + siteTextSpan('studio12BookCtaBody', bcBody) + '</p>' +
      '<a class="s12-btn-dark s12-info-book-btn" href="' + bookUrl + '" data-cta-key="wc.s12.bookSectionCta">' + wcSpan(tenant, 'wc.s12.bookSectionCta', 'Request appointment') + '</a>' +
      s12BookGridImg, ' id="s12-booking"')
    : '';
  var s12InfoInnerHtml = '<div class="' + s12InfoInnerClass + '">' + s12HoursHalf + s12BookGridHalf + s12StudioHalf + s12MapHalf + '</div>';
  var heroEyebrow = tenantSiteTextOrCompute(tenant, 'studio12HeroEyebrow', s12.heroEyebrow);
  var heroMerged = (tenant.studio12HeroHeadline || '').trim();
  var heroL1, heroL2;
  if (heroMerged) {
    var hh = studio12SplitHeroHeadline(heroMerged);
    heroL1 = hh.line1;
    heroL2 = hh.line2;
  } else {
    heroL1 = tenantSiteTextOrCompute(tenant, 'studio12HeroLine1', s12.heroLine1);
    heroL2 = tenantSiteTextOrCompute(tenant, 'studio12HeroLine2', s12.heroLine2);
  }
  var s12HeroActions = '<div class="s12-hero-actions s12-fade">';
  if (tenantShowBookPage(tenant)) {
    s12HeroActions += '<a class="s12-btn-dark" href="' + bookUrl + '" data-cta-key="wc.s12.heroReserve">' + wcSpan(tenant, 'wc.s12.heroReserve', 'Reserve your visit') + '</a>';
  }
  s12HeroActions += '<a class="s12-btn-outline" href="' + exploreHref + '" data-cta-key="wc.s12.exploreCta">' + wcSpan(tenant, 'wc.s12.exploreCta', exploreLabel) + '</a></div>';
  var gallerySectionHtml = tenantShowGalleryPage(tenant)
    ? '<section class="s12-gallery-light" data-bk-color-surface="featured"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.gallery') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="s12-gallery-head">' +
    '<div class="s12-fade"><div class="s12-phil-label" style="color:var(--s12-clay)">' + wcSpan(tenant, 'wc.s12.galleryLabel', 'Our work') + '</div>' +
    '<h2 class="s12-gallery-title">' + wcSpan(tenant, 'wc.s12.galleryTitleLead', 'The') + ' <em>' + wcSpan(tenant, 'wc.s12.galleryTitleEm', 'gallery') + '</em></h2></div>' +
    (igLink ? '<a class="s12-gallery-link s12-fade" href="' + igLink + '" target="_blank" rel="noopener"><span data-edit-key="wc.contact.instagram">@' + esc(webCopyOverrideText(tenant, 'wc.contact.instagram', ig)) + '</span></a>' : '<a class="s12-gallery-link s12-fade" href="' + galleryUrl + '">' + wcSpan(tenant, 'wc.s12.galleryViewLink', 'View gallery') + '</a>') +
    '</div>' + studio12GalleryMarqueeHtml(gItems, Math.max(1, gUrls.length))) + '</section>'
    : '';
  return '<div class="studio12-page">' + studio12NavHtml(tenant) +
    '<section class="s12-hero" data-bk-color-surface="hero"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.hero') + '>' +
    bkHeroBandHitButtonHtml() +
    '<div class="s12-hero-img-col"' + s12HeroColStyle + '>' + heroImg + '<div class="s12-hero-img-overlay"></div>' + bkHeroImageHitButtonHtml() + '</div>' +
    '<div class="s12-hero-content" data-bk-hero-band-tappable>' +
    '<div class="s12-hero-tag s12-fade">' + siteTextSpan('studio12HeroEyebrow', heroEyebrow) + '</div>' +
    '<h1 class="s12-hero-title s12-fade">' + siteTextSpan('studio12HeroLine1', heroL1) + '<br>' + siteTextSpan('studio12HeroLine2', heroL2) + '<br><em>' + siteTextSpan('heroTagline', heroItalic) + '</em></h1>' +
    '<p class="s12-hero-sub s12-fade">' + wcSpan(tenant, 'wc.s12.heroLead', heroLead) + '</p>' +
    s12HeroActions +
    '</div></section>' +
    '<div class="s12-marquee"><div class="s12-marquee-inner">' + marqueeHtml + marqueeHtml + '</div></div>' +
    '<section class="s12-philosophy" data-bk-color-surface="card"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.philosophy') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap('<div class="s12-fade s12-phil-media">' + philImgCol + '</div>' +
    '<div class="s12-fade s12-phil-copy"><div class="s12-phil-label">' + wcSpan(tenant, 'wc.s12.philosophyLabel', 'Our approach') + '</div>' +
    philTitleHtml +
    '<p class="s12-phil-body">' + wcSpan(tenant, 'wc.s12.philBody1', philBody1) + '</p>' +
    '<p class="s12-phil-body">' + wcSpan(tenant, 'wc.s12.philBody2', philBody2) + '</p></div>') + '</section>' +
    servicesSectionHtml +
    gallerySectionHtml +
    processSectionHtml +
    testSection +
    studio12HomeShopSectionHtml(tenant) +
    teamHomeSectionHtml(tenant) +
    '<div class="' + s12InfoClass + '" data-bk-color-surface="about"' +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.info') + ' data-bk-band-tappable>' +
    bkColorBandInnerWrap(s12InfoInnerHtml) + '</div>' +
    studio12SiteFooterHtml(tenant) + studio12SidebarHtml(tenant) + galleryLightboxShellHtml() + '</div>';
}

function studio12ShopCheckoutPage(tenant) {
  return '<div class="studio12-page studio12-sub">' + studio12NavHtml(tenant) +
    '<div class="s12-services" style="padding-top:100px;padding-bottom:80px">' + shopCheckoutInnerHtml(tenant) + '</div>' +
    studio12SiteFooterHtml(tenant) + studio12SidebarHtml(tenant) + '</div>';
}
