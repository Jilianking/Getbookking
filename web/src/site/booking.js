/* Booking pages and forms. */

/** Tenant slug from `{slug}.getbookking.com` or `{slug}.getbooking.com`. */
function tenantSlugFromBookingHost(host) {
  host = (host || '').toLowerCase();
  var apexes = ['getbookking.com', 'getbooking.com'];
  for (var i = 0; i < apexes.length; i++) {
    var apex = apexes[i];
    if (host === apex || host === ('www.' + apex)) return '';
    var suffix = '.' + apex;
    if (host.endsWith(suffix) && host.length > suffix.length) {
      var sub = host.slice(0, -suffix.length);
      if (sub && sub.indexOf('.') === -1) return sub;
    }
  }
  return '';
}

function isBookkingPlatformHost(host) {
  host = (host || '').toLowerCase();
  var apexes = ['getbookking.com', 'getbooking.com'];
  for (var i = 0; i < apexes.length; i++) {
    var apex = apexes[i];
    if (host === apex || host === ('www.' + apex) || host.endsWith('.' + apex)) return true;
  }
  return false;
}

function tenantBookingPlatformHost(host) {
  host = (host || '').toLowerCase();
  return host.indexOf('getbooking.com') !== -1 ? 'getbooking.com' : 'getbookking.com';
}

function bookingArtistFieldHtml(providers, selectedProvider, assignmentPreference, industry) {
  if (!providers || !providers.length) return '';
  var selectedSlug = selectedProvider && selectedProvider.memberSlug
    ? String(selectedProvider.memberSlug).toLowerCase() : '';
  var isFirst = assignmentPreference === 'first_available' ||
    (!selectedSlug && !selectedProvider);
  var opts = '<option value=""' + (isFirst ? ' selected' : '') + '>First available</option>';
  for (var i = 0; i < providers.length; i++) {
    var prov = providers[i];
    var slug = String(prov.memberSlug || '').toLowerCase();
    if (!slug) continue;
    var sel = (!isFirst && slug === selectedSlug) ? ' selected' : '';
    opts += '<option value="' + esc(slug) + '"' + sel + '>' + esc(prov.displayName || slug) + '</option>';
  }
  var roleLabel = bookingProviderRoleLabel(industry);
  return '<div class="bk-book-artist-field">' +
    '<label for="bk-book-artist">' + esc(roleLabel) + '</label>' +
    '<select id="bk-book-artist" name="bk_book_artist" data-bk-artist-select>' + opts + '</select>' +
  '</div>';
}

function bindBookingArtistSelect(tenant, providers) {
  var sel = document.getElementById('bk-book-artist');
  if (!sel || !providers || !providers.length) return;
  var bySlug = {};
  for (var i = 0; i < providers.length; i++) {
    bySlug[String(providers[i].memberSlug || '').toLowerCase()] = providers[i];
  }
  function applySelection() {
    var v = String(sel.value || '').toLowerCase();
    if (!v) {
      tenant._activeProvider = null;
      tenant._assignmentPreference = 'first_available';
    } else {
      tenant._activeProvider = bySlug[v] || null;
      tenant._assignmentPreference = null;
    }
  }
  sel.addEventListener('change', applySelection);
  applySelection();
}

/** Gallery / featured empty slots: accent + card. */
function tenantPlaceholderSlotStyle(c, options) {
  var opts = options || {};
  var accentMix = opts.accentMix != null ? opts.accentMix : 32;
  var cardMix = 100 - accentMix;
  var borderAlpha = opts.borderAlpha != null ? opts.borderAlpha : 0.55;
  var borderWidth = opts.borderWidth || '2px';
  return {
    bg: 'color-mix(in srgb, ' + c.accent + ' ' + accentMix + '%, ' + c.card + ' ' + cardMix + '%)',
    border: borderWidth + ' dashed ' + rgbaFromHex(c.accent, borderAlpha)
  };
}

/** Hero empty slot: strong accent tint so it matches BOOK NOW / primary buttons. */
function tenantHeroPlaceholderSlotStyle(c) {
  var accentMix = 48;
  var baseMix = 52;
  var rgb = hexToRgb(c.accent);
  var lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  var base = lum > 0.62 ? c.bg : c.card;
  return {
    bg: 'color-mix(in srgb, ' + c.accent + ' ' + accentMix + '%, ' + base + ' ' + baseMix + '%)',
    border: '2px dashed ' + rgbaFromHex(c.accent, 0.68)
  };
}

/** Applies accent-tinted fills to all empty hero / featured image slots (builder preview + live site). */
function applyEmptyImageSlotColors(tenant) {
  if (!tenant) return;
  var c = tenantColors(tenant);
  var heroSlot = tenantHeroPlaceholderSlotStyle(c);
  var slot = tenantPlaceholderSlotStyle(c, { accentMix: 32, borderAlpha: 0.55 });
  var slotLight = tenantPlaceholderSlotStyle(c, { accentMix: 22, borderAlpha: 0.35, borderWidth: '1px' });
  var heroSelectors = [
    '.classic-hero-placeholder',
    '.blade-page .blade-hero-placeholder',
    '.stonecut-page .stonecut-hero-photo--empty',
    '.studio12-page .s12-hero-img-fallback',
    '.studio12-page .s12-hero-img-col:not(:has(img))',
    '.luxe-hero--empty',
    '.charter-hero-media [data-edit-key="heroImage"]:not(img):not(.bk-hero-image-hit)',
    '.charter-hero-slot'
  ];
  heroSelectors.forEach(function(sel) {
    [].forEach.call(document.querySelectorAll(sel), function(el) {
      el.style.background = heroSlot.bg;
      el.style.border = heroSlot.border;
    });
  });
  var slotSelectors = [
    '.studio12-page .s12-aux-img-wrap:not(:has(img))',
    '.tattoo-featured-slot-add',
    '.classic-home .tattoo-featured-slot-add',
    '.luxe-service-placeholder--add',
    '.charter-page .charter-photo-slot',
    '.charter-page .charter-browse-ph',
    '.charter-page .charter-about-photo--empty',
    '.charter-page .charter-quote-media [data-edit-key]:not(img)',
    '.charter-page .charter-quote-ph'
  ];
  slotSelectors.forEach(function(sel) {
    [].forEach.call(document.querySelectorAll(sel), function(el) {
      el.style.background = slot.bg;
      el.style.border = slot.border;
    });
  });
  [].forEach.call(document.querySelectorAll('.tattoo-featured-placeholder'), function(el) {
    el.style.background = slotLight.bg;
    el.style.border = slotLight.border;
  });
}

/** Booking outer band — Blade / Luxe / Stonecut / Studio 12 key (`*.bookingPage`); does not rewrite home `--bk-bg`. */
function bookingPageBandOpenTag(tenant, bookPageStyle) {
  return '<div class="booking-page-band" data-bk-color-surface="page"' +
    bladeBkSurfaceKeyAttr(tenant, 'blade.bookingPage') +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.bookingPage') +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.bookingPage') +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.bookingPage') +
    charterBkSurfaceKeyAttr(tenant, 'charter.bookingPage') +
    ' data-bk-band-tappable' + (bookPageStyle ? ' style="' + bookPageStyle + '"' : '') + '>';
}

/** Blade / Luxe / Stonecut / Studio 12 /book root — same key as the outer band so the visible canvas is tappable. */
function bookingPageWrapOpenTag(tenant, wrapClass) {
  var extra = '';
  if (isBladeTheme(tenant)) {
    extra = ' data-bk-color-surface="page"' + bladeBkSurfaceKeyAttr(tenant, 'blade.bookingPage');
  } else if (isLuxeTheme(tenant)) {
    extra = ' data-bk-color-surface="page"' + luxeBkSurfaceKeyAttr(tenant, 'luxe.bookingPage');
  } else if (isStonecutTheme(tenant)) {
    extra = ' data-bk-color-surface="page"' + stonecutBkSurfaceKeyAttr(tenant, 'stonecut.bookingPage');
  } else if (isStudio12Theme(tenant)) {
    extra = ' data-bk-color-surface="page"' + studio12BkSurfaceKeyAttr(tenant, 'studio12.bookingPage');
  } else if (isCharterTheme(tenant)) {
    extra = ' data-bk-color-surface="page"' + charterBkSurfaceKeyAttr(tenant, 'charter.bookingPage');
  }
  return '<div class="' + wrapClass + '"' + extra + '>';
}

/** Booking form card — Blade / Luxe / Stonecut / Studio 12 independent fill. */
function bookingCardOpenTag(tenant) {
  return '<div class="booking-card" data-bk-color-surface="card"' +
    bladeBkSurfaceKeyAttr(tenant, 'blade.bookingCard') +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.bookingCard') +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.bookingCard') +
    studio12BkSurfaceKeyAttr(tenant, 'studio12.bookingCard') +
    charterBkSurfaceKeyAttr(tenant, 'charter.bookingCard') +
    ' data-bk-band-tappable>';
}

function bookingNameFieldAttrs(f) {
  if ((f.key || '') !== 'name') return '';
  return ' autocapitalize="words" autocorrect="off" spellcheck="false"';
}

/** `/book` submit — keyed on all templates except Charter. */
function bookingSubmitButtonHtml(tenant, extraAttrs) {
  extraAttrs = extraAttrs || '';
  if (isCharterTheme(tenant)) {
    return '<button type="submit" class="booking-submit" data-cta-key="wc.book.submit"' + extraAttrs + '>' +
      wcSpan(tenant, 'wc.book.submit', 'Request booking') + '</button>';
  }
  return '<button type="submit" class="booking-submit" data-cta-key="wc.book.submit"' + extraAttrs + '>' +
    wcSpan(tenant, 'wc.book.submit', 'Request booking') + '</button>';
}

/** Minimal footer for /book when theme has no site footer (e.g. default tattoo). */
function minimalBookLegalFooterHtml(tenant) {
  return '<footer class="classic-footer book-legal-footer">' +
    '<p class="classic-footer-copy">' + footerLegalLineHtml(tenant) + '</p>' +
    '</footer>';
}

function publicSitePageUnavailableHtml(tenant) {
  var base = tenantBaseUrl(tenant);
  return '<div class="container"><div class="card"><p>This page isn’t available.</p><p><a href="' + esc(base + '/home') + '">Back to home</a></p></div></div>';
}

function tenantShowBookPage(tenant) {
  return tenant.showBookPage !== false;
}

/** Default /book subtitle when no `wc.book.pageSubtitle` override (theme-aware). */
function bookingPageSubtitleFallback(tenant) {
  var raw = tenant.tagline && String(tenant.tagline).trim();
  if (raw) return raw;
  if (isLuxeTheme(tenant)) return defaultLuxeHeroTaglineForIndustry(tenant.industry);
  if (isBladeTheme(tenant)) return defaultBladeHeroDescriptionForIndustry(tenant.industry);
  if (isStonecutTheme(tenant)) {
    var about = (tenant.aboutText && String(tenant.aboutText).trim()) || '';
    if (about) return about.split('\n')[0].slice(0, 160);
  }
  return defaultLuxeHeroTaglineForIndustry(tenant.industry);
}

/** Editable /book tagline (quick-edit key `wc.book.pageSubtitle`). */
function bookingPageTaglineInnerHtml(tenant) {
  return wcSpan(tenant, 'wc.book.pageSubtitle', bookingPageSubtitleFallback(tenant));
}

function bookingPageEyebrowInnerHtml(tenant) {
  var sa = (tenant.serviceArea && String(tenant.serviceArea).trim()) || '';
  var inner;
  if (isBladeTheme(tenant)) {
    inner = wcSpan(tenant, 'wc.blade.bookEyebrow', tenantSiteDisplayName(tenant, 'Studio'));
    if (sa) inner += ' \u00b7 ' + wcSpan(tenant, 'wc.contact.serviceArea', sa);
  } else if (isStonecutTheme(tenant)) {
    inner = wcSpan(tenant, 'wc.stonecut.bookEyebrow', tenantSiteDisplayName(tenant, 'Studio'));
    if (sa) inner += ' \u00b7 ' + wcSpan(tenant, 'wc.stonecut.bookServiceArea', sa);
  } else if (isStudio12Theme(tenant)) {
    inner = wcSpan(tenant, 'wc.s12.bookEyebrow', tenantSiteDisplayName(tenant, 'Studio'));
    if (sa) inner += ' \u00b7 ' + wcSpan(tenant, 'wc.s12.bookServiceArea', sa);
  } else if (isCharterTheme(tenant)) {
    inner = wcSpan(tenant, 'wc.charter.bookEyebrow', tenantSiteDisplayName(tenant, 'Harbor Charters'));
    if (sa) inner += ' \u00b7 ' + wcSpan(tenant, 'wc.charter.bookServiceArea', sa);
  } else {
    inner = siteNameSpan(tenant, 'Studio', '');
    if (sa) inner += ' \u00b7 ' + wcSpan(tenant, 'wc.contact.serviceArea', sa);
  }
  return inner;
}

/** Branded /book hero: name · city, title, tagline — all templates. */
function brandedBookingPageHeaderHtml(tenant, provider) {
  var taglineInner = bookingPageTaglineInnerHtml(tenant);
  var subtitleHtml = taglineInner
    ? '<p class="booking-page-subtitle booking-page-subtitle--tagline"><em>' + taglineInner + '</em></p>'
    : '';
  return '<div class="booking-page-header booking-page-header--branded">' +
    '<p class="booking-page-eyebrow">' + bookingPageEyebrowInnerHtml(tenant) + '</p>' +
    '<h1 class="booking-page-title">' + wcSpan(tenant, 'wc.book.pageTitle', 'Book an appointment') + '</h1>' +
    subtitleHtml +
  '</div>';
}

/** Calendar / slots when booking mode is calendar_slots (or legacy form style calendar). */
function bookingModeResolved(tenant) {
  function isCalendarToken(raw) {
    var m = String(raw || '').trim().toLowerCase();
    return m === 'calendar_slots' || m === 'calendar' || m === 'slots'
      || m === 'slot_booking' || m === 'online_booking' || m === 'online';
  }
  function isFormToken(raw) {
    var m = String(raw || '').trim().toLowerCase();
    return m === 'form' || m === 'inquiry' || m === 'request';
  }
  if (!tenant) return 'form';
  if (isCharterPlan(tenant) || isCharterTheme(tenant)) return 'calendar_slots';
  // Any of these fields can flip calendar — do not let a stale "form" win over calendar_slots.
  var candidates = [];
  if (tenant.workflow && tenant.workflow.bookingMode != null && tenant.workflow.bookingMode !== '') {
    candidates.push(tenant.workflow.bookingMode);
  }
  if (tenant.bookingMode != null && tenant.bookingMode !== '') {
    candidates.push(tenant.bookingMode);
  }
  var i;
  for (i = 0; i < candidates.length; i++) {
    if (isCalendarToken(candidates[i])) return 'calendar_slots';
  }
  for (i = 0; i < candidates.length; i++) {
    if (isFormToken(candidates[i])) return 'form';
  }
  var style = String(tenant.bookingFormStyleId || '').trim().toLowerCase();
  if (style === 'calendar' || style === 'online' || style === 'online_booking' || style === 'appointments') {
    return 'calendar_slots';
  }
  return 'form';
}

/** Form layout only when booking mode is form. Calendar forced by bookingMode. */
function bookingFormStyleResolved(tenant) {
  if (bookingModeResolved(tenant) === 'calendar_slots') return 'calendar';
  var raw = String((tenant && tenant.bookingFormStyleId) || '').trim().toLowerCase();
  return raw === 'guided' ? 'guided' : 'standard';
}

function usesGuidedBookingForm(tenant) {
  return bookingFormStyleResolved(tenant) === 'guided';
}

function usesCalendarBookingForm(tenant) {
  return bookingFormStyleResolved(tenant) === 'calendar';
}

/** Mon=0 … Sun=6 (matches app / businessHoursWeekly keys). */
function calendarWeekdayIndex(date) {
  var d = date.getDay();
  return d === 0 ? 6 : d - 1;
}

function calendarParseDaySchedule(dayMap) {
  if (!dayMap || typeof dayMap !== 'object') return { closed: true, ranges: [] };
  var closed = dayMap.closed === true;
  var ranges = Array.isArray(dayMap.ranges) ? dayMap.ranges : [];
  if (!ranges.length && dayMap.openMin != null && dayMap.closeMin != null) {
    ranges = [{ openMin: dayMap.openMin, closeMin: dayMap.closeMin }];
  }
  function intMin(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return Math.max(0, Math.min(Math.floor(v), 24 * 60 - 1));
    var n = parseInt(String(v), 10);
    return isNaN(n) ? 0 : Math.max(0, Math.min(n, 24 * 60 - 1));
  }
  if (closed || !ranges.length) return { closed: true, ranges: [] };
  return {
    closed: false,
    ranges: ranges.map(function(r) {
      return {
        openMin: intMin(r.openMin != null ? r.openMin : r.startMin),
        closeMin: intMin(r.closeMin != null ? r.closeMin : r.endMin)
      };
    })
  };
}

/** Day schedule from shop businessHoursWeekly (not online autofill). */
function calendarDaySchedule(tenant, date) {
  var keys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var idx = calendarWeekdayIndex(date);
  var w = tenant && tenant.businessHoursWeekly;
  if (w && typeof w === 'object' && Object.keys(w).length) {
    return calendarParseDaySchedule(w[keys[idx]]);
  }
  // Fallback: Sat/Sun closed, weekdays 9–17.
  if (idx >= 5) return { closed: true, ranges: [] };
  return { closed: false, ranges: [{ openMin: 9 * 60, closeMin: 17 * 60 }] };
}

function calendarIsoDate(date) {
  var y = date.getFullYear();
  var m = date.getMonth() + 1;
  var d = date.getDate();
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

function calendarIsFullDayBlocked(tenant, date) {
  var key = calendarIsoDate(date);
  var blocked = tenant && Array.isArray(tenant.blockedDates) ? tenant.blockedDates : [];
  return blocked.indexOf(key) >= 0;
}

function calendarPartialBlocksForDay(tenant, date) {
  var key = calendarIsoDate(date);
  var list = tenant && Array.isArray(tenant.blockedTimeRanges) ? tenant.blockedTimeRanges : [];
  return list.filter(function(b) {
    var d = (b && (b.date || b.dateYmd)) ? String(b.date || b.dateYmd) : '';
    return d === key;
  }).map(function(b) {
    var s = parseInt(b.startMin != null ? b.startMin : b.startMinutes, 10);
    var e = parseInt(b.endMin != null ? b.endMin : b.endMinutes, 10);
    if (isNaN(s)) s = 0;
    if (isNaN(e)) e = s + 30;
    return { startMin: s, endMin: e };
  });
}

function calendarStartOverlapsBlock(startMin, durationMin, blocks) {
  var end = startMin + Math.max(5, durationMin || 30);
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (startMin < b.endMin && end > b.startMin) return true;
  }
  return false;
}

function calendarFormatMin(m) {
  var h = Math.floor(m / 60);
  var min = m % 60;
  var d = new Date(2000, 0, 1, h, min);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function calendarSlotsForDay(tenant, date, stepMin) {
  var step = stepMin || (tenant && tenant.onlineSlotStepMinutes) || 30;
  if (typeof step !== 'number' || step < 5) step = 30;
  if (calendarIsFullDayBlocked(tenant, date)) return [];
  var day = calendarDaySchedule(tenant, date);
  if (day.closed || !day.ranges.length) return [];
  var blocks = calendarPartialBlocksForDay(tenant, date);
  var slots = [];
  var now = new Date();
  var isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  var nowMin = now.getHours() * 60 + now.getMinutes();
  for (var ri = 0; ri < day.ranges.length; ri++) {
    var open = day.ranges[ri].openMin;
    var close = day.ranges[ri].closeMin;
    for (var t = open; t + step <= close; t += step) {
      if (isToday && t <= nowMin) continue;
      if (calendarStartOverlapsBlock(t, step, blocks)) continue;
      slots.push({ min: t, label: calendarFormatMin(t) });
    }
  }
  return slots;
}

function calendarPrettyDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function calendarLongDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function calendarServiceMetaLine(s) {
  return guidedServiceMetaLine(s);
}

function formCalendarWizardHtml(tenant, fields, services, presel, provider) {
  var providers = (isTeamPlan(tenant) && tenant._bookProviders && tenant._bookProviders.length)
    ? tenant._bookProviders
    : [];
  var hasStaff = providers.length > 0 && !(provider && provider.memberSlug);
  var preStaff = provider && provider.memberSlug
    ? String(provider.memberSlug).toLowerCase()
    : '';
  var preStaffName = provider && provider.displayName ? String(provider.displayName) : '';
  var staffCards = providers.map(function(p) {
    var slug = String(p.memberSlug || '').toLowerCase();
    var active = preStaff && preStaff === slug ? ' is-active' : '';
    var sub = teamMemberPickerSubtitle(p);
    return '<button type="button" class="booking-cal-card' + active + '" data-cal-staff="' + esc(slug) + '" data-cal-staff-name="' + esc(p.displayName || slug) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
      '<span class="name">' + esc(p.displayName || slug) + '</span>' +
      (sub ? '<span class="meta">' + esc(sub) + '</span>' : '') +
      '</button>';
  }).join('');
  var initService = presel ? presel.id : '';
  var initServiceName = presel ? (presel.name || '') : '';
  var initServiceSlug = presel ? (presel.slug || '') : '';
  var serviceCards = (services || []).map(function(s) {
    var active = (presel && presel.id === s.id) ? ' is-active' : '';
    return '<button type="button" class="booking-cal-card' + active + '" data-cal-service-id="' + esc(s.id) + '" data-cal-service-name="' + esc(s.name) + '" data-cal-service-slug="' + esc(s.slug || '') + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
      '<span class="name">' + esc(s.name) + '</span>' +
      '<span class="meta">' + esc(calendarServiceMetaLine(s)) + '</span>' +
      '</button>';
  }).join('');
  var skipKeys = {
    service: true,
    preferredDays: true,
    preferredTime: true,
    preferredTimeOfDay: true
  };
  var detailFields = (fields || []).filter(function(f) {
    return f && f.key && !skipKeys[f.key];
  });
  var detailsHtml = detailFields.map(function(f) {
    var raw = field(f, services, presel);
    // Promote inputs for calendar spacing class without rewriting field().
    return '<div class="booking-cal-field">' + raw
      .replace(/<(input|select|textarea)\b/g, '<$1 class="field-input"')
      .replace(/class="field-input" class="/g, 'class="field-input ') +
      '</div>';
  }).join('');
  // Month calendar + times filled in setupCalendarBookingForm
  var labels = [];
  if (hasStaff) labels.push('Staff');
  labels.push('Service', 'Date & time', 'Details', 'Summary');
  var labelsHtml = labels.map(function(lab, i) {
    return '<span data-cal-step-label="' + i + '"' + (i === 0 ? ' class="is-active"' : '') + '>' + esc(lab) + '</span>';
  }).join('');
  var panelIdx = 0;
  var panels = '';
  if (hasStaff) {
    panels +=
      '<div class="booking-cal-panel" data-cal-panel="' + panelIdx + '" data-cal-kind="staff">' +
        '<p class="booking-cal-day-title">Who would you like to book?</p>' +
        '<div class="booking-cal-staff-grid" data-cal-staff-grid>' + staffCards + '</div>' +
      '</div>';
    panelIdx++;
  }
  panels +=
    '<div class="booking-cal-panel" data-cal-panel="' + panelIdx + '" data-cal-kind="service"' + (hasStaff ? ' hidden' : '') + '>' +
      '<p class="booking-cal-day-title">Choose a service</p>' +
      '<div class="booking-cal-service-grid" data-cal-service-grid>' + serviceCards + '</div>' +
    '</div>';
  panelIdx++;
  var schedIdx = panelIdx;
  panels +=
    '<div class="booking-cal-panel" data-cal-panel="' + panelIdx + '" data-cal-kind="schedule" hidden>' +
      '<p class="booking-cal-day-title">Choose a day</p>' +
      '<div class="booking-cal-month" data-cal-month>' +
        '<div class="booking-cal-month-header">' +
          '<button type="button" class="booking-cal-month-nav" data-cal-month-prev aria-label="Previous month">‹</button>' +
          '<p class="booking-cal-month-title" data-cal-month-title>Month</p>' +
          '<button type="button" class="booking-cal-month-nav" data-cal-month-next aria-label="Next month">›</button>' +
        '</div>' +
        '<div class="booking-cal-month-dows" aria-hidden="true">' +
          '<span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span>' +
        '</div>' +
        '<div class="booking-cal-month-grid" data-cal-month-grid role="grid" aria-label="Calendar"></div>' +
      '</div>' +
      '<div class="booking-cal-times-block" data-cal-times-block hidden>' +
        '<p class="booking-cal-day-title" data-cal-day-heading>Pick a time</p>' +
        '<div class="booking-cal-slots" data-cal-slots></div>' +
        '<p class="booking-cal-hint">Times follow studio hours. We’ll confirm your appointment after you request.</p>' +
      '</div>' +
    '</div>';
  panelIdx++;
  panels +=
    '<div class="booking-cal-panel" data-cal-panel="' + panelIdx + '" data-cal-kind="details" hidden>' +
      '<p class="booking-cal-day-title">Your details</p>' +
      '<div class="booking-cal-details-fields">' + detailsHtml + '</div>' +
    '</div>';
  panelIdx++;
  var confirmIdx = panelIdx;
  panels +=
    '<div class="booking-cal-panel" data-cal-panel="' + panelIdx + '" data-cal-kind="summary" hidden>' +
      '<p class="booking-cal-day-title">Review</p>' +
      '<dl class="booking-cal-summary" data-cal-summary></dl>' +
      '<p class="booking-cal-hint" data-cal-deposit-note>No payment is collected on this step — we confirm by message. Deposits (if required) are arranged after we accept.</p>' +
    '</div>';

  return {
    html: panels,
    hasStaff: hasStaff,
    confirmStep: String(confirmIdx),
    scheduleStep: String(schedIdx),
    preStaff: preStaff,
    preStaffName: preStaffName,
    initService: initService,
    initServiceName: initServiceName,
    initServiceSlug: initServiceSlug,
    labelsHtml: labelsHtml
  };
}

function setupCalendarBookingForm(fm, tenant, services) {
  if (!fm || !fm.hasAttribute('data-cal-wizard-form')) return;
  var monthGrid = fm.querySelector('[data-cal-month-grid]');
  var monthTitle = fm.querySelector('[data-cal-month-title]');
  var monthPrev = fm.querySelector('[data-cal-month-prev]');
  var monthNext = fm.querySelector('[data-cal-month-next]');
  var timesBlock = fm.querySelector('[data-cal-times-block]');
  var slotsEl = fm.querySelector('[data-cal-slots]');
  var dayHeading = fm.querySelector('[data-cal-day-heading]');
  var summaryEl = fm.querySelector('[data-cal-summary]');
  var backBtn = fm.querySelector('[data-cal-back]');
  var nextBtn = fm.querySelector('[data-cal-next]');
  var submitBtn = fm.querySelector('[data-cal-submit]');
  var errEl = fm.querySelector('#form-error') || document.getElementById('form-error');
  var serviceInput = fm.querySelector('[data-key="service"]');
  var daysInput = fm.querySelector('[data-key="preferredDays"]');
  var timeInput = fm.querySelector('[data-key="preferredTime"]');
  var staffInput = fm.querySelector('[data-cal-member-slug]');
  var staffNameInput = fm.querySelector('[data-cal-member-name]');
  var panels = fm.querySelectorAll('[data-cal-panel]');
  var labels = fm.querySelectorAll('[data-cal-step-label]');
  var maxStep = panels.length ? panels.length - 1 : 0;
  var step = 0;
  var selectedIso = '';
  var selectedPretty = '';
  var selectedTime = '';
  var MONTH_HORIZON = 4; // current month + next 4
  var now = new Date();
  var viewYear = now.getFullYear();
  var viewMonth = now.getMonth(); // 0-based
  var minMonthKey = viewYear * 12 + viewMonth;
  var maxMonthKey = minMonthKey + MONTH_HORIZON;

  // Times already taken (held, requested or booked) so two clients can't pick the same one.
  var busy = [];
  if (typeof functions !== 'undefined' && tenant && tenant.slug) {
    functions.httpsCallable('getShopBusyTimes')({ tenantSlug: tenant.slug }).then(function(res) {
      busy = (res && res.data && res.data.busy) || [];
      if (busy.length) paintMonthGrid();
    }).catch(function() { /* page still works; the server re-checks on submit */ });
  }
  function isoOf(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function serviceMinutes() {
    var id = serviceInput && serviceInput.value;
    for (var i = 0; i < (services || []).length; i++) {
      if (services[i] && services[i].id === id) {
        var m = Number(services[i].durationMinutes);
        if (m > 0) return m;
      }
    }
    return 30;
  }
  function openSlots(date) {
    var slots = calendarSlotsForDay(tenant, date, 30);
    if (!busy.length) return slots;
    var iso = isoOf(date);
    var who = (staffInput && staffInput.value) || '';
    var dur = serviceMinutes();
    return slots.filter(function(sl) {
      for (var i = 0; i < busy.length; i++) {
        var b = busy[i];
        if (b.date !== iso || (b.member || '') !== who) continue;
        if (sl.min < b.endMin && b.startMin < sl.min + dur) return false;
      }
      return true;
    });
  }

  function showError(msg) {
    if (!errEl) return;
    if (!msg) {
      errEl.style.display = 'none';
      errEl.textContent = '';
      return;
    }
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  function monthLabel(y, m) {
    return new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function startOfDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function isPastDay(date) {
    return startOfDay(date).getTime() < startOfDay(new Date()).getTime();
  }

  function isToday(date) {
    var t = new Date();
    return date.getFullYear() === t.getFullYear() &&
      date.getMonth() === t.getMonth() &&
      date.getDate() === t.getDate();
  }

  function dayIsBookable(date) {
    if (isPastDay(date)) return false;
    var slots = openSlots(date);
    return slots.length > 0;
  }

  function selectDay(iso, pretty, longLabel) {
    selectedIso = iso || '';
    fm.setAttribute('data-cal-iso', selectedIso);
    selectedPretty = pretty || iso || '';
    selectedTime = '';
    if (timeInput) timeInput.value = '';
    if (daysInput) daysInput.value = selectedPretty;
    if (timesBlock) timesBlock.hidden = !selectedIso;
    paintMonthGrid();
    paintSlots(longLabel || selectedPretty);
    showError('');
    if (timesBlock && selectedIso) {
      try {
        timesBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) { /* ignore */ }
    }
  }

  function paintMonthGrid() {
    if (!monthGrid) return;
    if (monthTitle) monthTitle.textContent = monthLabel(viewYear, viewMonth);
    var curKey = viewYear * 12 + viewMonth;
    if (monthPrev) monthPrev.disabled = curKey <= minMonthKey;
    if (monthNext) monthNext.disabled = curKey >= maxMonthKey;

    var first = new Date(viewYear, viewMonth, 1, 12, 0, 0, 0);
    var startPad = first.getDay(); // Su=0
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    var html = '';
    for (var p = 0; p < startPad; p++) {
      html += '<button type="button" class="booking-cal-mday is-outside" tabindex="-1" disabled aria-hidden="true"></button>';
    }
    for (var day = 1; day <= daysInMonth; day++) {
      var d = new Date(viewYear, viewMonth, day, 12, 0, 0, 0);
      var iso = calendarIsoDate(d);
      var past = isPastDay(d);
      var bookable = dayIsBookable(d);
      var closed = !bookable && !past;
      var cls = 'booking-cal-mday';
      if (past) cls += ' is-past';
      if (closed) cls += ' is-closed';
      if (isToday(d)) cls += ' is-today';
      if (selectedIso === iso) cls += ' is-active';
      var disabled = past || !bookable;
      html += '<button type="button" class="' + cls + '" data-cal-day="' + esc(iso) +
        '" data-cal-day-label="' + esc(calendarPrettyDate(d)) +
        '" data-cal-day-long="' + esc(calendarLongDate(d)) + '"' +
        (disabled ? ' disabled aria-disabled="true"' : '') +
        ' aria-label="' + esc(calendarLongDate(d)) + '"' +
        (selectedIso === iso ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        '>' + day + '</button>';
    }
    // trailing cells to complete weeks
    var totalCells = startPad + daysInMonth;
    var trail = (7 - (totalCells % 7)) % 7;
    for (var t = 0; t < trail; t++) {
      html += '<button type="button" class="booking-cal-mday is-outside" tabindex="-1" disabled aria-hidden="true"></button>';
    }
    monthGrid.innerHTML = html;
    var buttons = monthGrid.querySelectorAll('[data-cal-day]');
    for (var bi = 0; bi < buttons.length; bi++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          if (btn.disabled) return;
          selectDay(
            btn.getAttribute('data-cal-day') || '',
            btn.getAttribute('data-cal-day-label') || '',
            btn.getAttribute('data-cal-day-long') || ''
          );
        });
      })(buttons[bi]);
    }

    // Keep times panel if a day is already selected (even when browsing another month)
    if (selectedIso) {
      var sp = selectedIso.split('-');
      var sd = new Date(parseInt(sp[0], 10), parseInt(sp[1], 10) - 1, parseInt(sp[2], 10), 12, 0, 0, 0);
      paintSlots(calendarLongDate(sd));
      if (timesBlock) timesBlock.hidden = false;
    } else {
      if (timesBlock) timesBlock.hidden = true;
      if (slotsEl) slotsEl.innerHTML = '';
    }
  }

  function paintSlots(longLabel) {
    if (!slotsEl) return;
    if (!selectedIso) {
      if (timesBlock) timesBlock.hidden = true;
      slotsEl.innerHTML = '';
      return;
    }
    if (timesBlock) timesBlock.hidden = false;
    if (dayHeading) {
      dayHeading.textContent = longLabel
        ? ('Times on ' + longLabel)
        : 'Pick a time';
    }
    var parts = selectedIso.split('-');
    var date = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0, 0);
    var slots = openSlots(date);
    if (!slots.length) {
      slotsEl.innerHTML = '<p class="booking-cal-empty">No open times this day.</p>';
      return;
    }
    var html = slots.map(function(s) {
      var active = selectedTime === s.label ? ' is-active' : '';
      return '<button type="button" class="booking-cal-slot' + active + '" data-cal-slot="' + esc(s.label) + '">' + esc(s.label) + '</button>';
    }).join('');
    slotsEl.innerHTML = html;
    var btns = slotsEl.querySelectorAll('[data-cal-slot]');
    for (var si = 0; si < btns.length; si++) {
      (function(btn) {
        btn.addEventListener('click', function() {
          selectedTime = btn.getAttribute('data-cal-slot') || '';
          if (timeInput) timeInput.value = selectedTime;
          for (var k = 0; k < btns.length; k++) {
            btns[k].classList.toggle('is-active', btns[k] === btn);
          }
          showError('');
        });
      })(btns[si]);
    }
  }

  if (monthPrev) {
    monthPrev.addEventListener('click', function() {
      var key = viewYear * 12 + viewMonth;
      if (key <= minMonthKey) return;
      viewMonth -= 1;
      if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
      paintMonthGrid();
    });
  }
  if (monthNext) {
    monthNext.addEventListener('click', function() {
      var key = viewYear * 12 + viewMonth;
      if (key >= maxMonthKey) return;
      viewMonth += 1;
      if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
      paintMonthGrid();
    });
  }

  function panelKind(panel) {
    return panel ? (panel.getAttribute('data-cal-kind') || '') : '';
  }
  function activePanel() {
    return fm.querySelector('[data-cal-panel="' + step + '"]');
  }
  function staffSelected() {
    return !!(staffInput && staffInput.value);
  }
  function serviceSelected() {
    return !!(serviceInput && serviceInput.value);
  }
  function scheduleSelected() {
    return !!(selectedIso && selectedTime);
  }
  function validateDetails() {
    var panel = activePanel();
    if (!panel || panelKind(panel) !== 'details') return true;
    var required = panel.querySelectorAll('[required]');
    for (var i = 0; i < required.length; i++) {
      var el = required[i];
      if (el.getAttribute('data-type') === 'file') continue;
      var v = (el.value || '').trim();
      if (!v) {
        el.focus && el.focus();
        return false;
      }
    }
    return true;
  }
  function buildSummary() {
    if (!summaryEl) return;
    var svcName = (serviceInput && serviceInput.getAttribute('data-name')) || '';
    var staffName = (staffNameInput && staffNameInput.value) || '';
    var nameEl = fm.querySelector('[data-key="name"]');
    var emailEl = fm.querySelector('[data-key="email"]');
    var phoneEl = fm.querySelector('[data-key="phone"]');
    var notesEl = fm.querySelector('[data-key="notes"]');
    function row(dt, dd) {
      if (!dd) return '';
      return '<dt>' + esc(dt) + '</dt><dd>' + esc(dd) + '</dd>';
    }
    summaryEl.innerHTML =
      row('Staff', staffName) +
      row('Service', svcName) +
      row('Date', selectedPretty) +
      row('Time', selectedTime) +
      row('Name', nameEl && nameEl.value) +
      row('Email', emailEl && emailEl.value) +
      row('Phone', phoneEl && phoneEl.value) +
      row('Notes', notesEl && notesEl.value);
  }
  function renderStep() {
    showError('');
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      var idx = parseInt(p.getAttribute('data-cal-panel'), 10);
      p.hidden = idx !== step;
    }
    for (var li = 0; li < labels.length; li++) {
      labels[li].classList.toggle('is-active', parseInt(labels[li].getAttribute('data-cal-step-label'), 10) === step);
    }
    if (backBtn) backBtn.hidden = step === 0;
    var atConfirm = step >= maxStep;
    if (nextBtn) nextBtn.hidden = atConfirm;
    if (submitBtn) submitBtn.hidden = !atConfirm;
    fm.dataset.calStep = String(step);
    var kind = panelKind(activePanel());
    if (kind === 'schedule') paintMonthGrid();
    if (kind === 'summary') buildSummary();
    var smsBlock = fm.querySelector('[data-sms-consent-cal]');
    if (smsBlock) smsBlock.hidden = !(kind === 'details' || kind === 'summary');
  }
  function canAdvance() {
    var kind = panelKind(activePanel());
    if (kind === 'staff') {
      if (!staffSelected()) {
        showError('Please choose who you’d like to book.');
        return false;
      }
    } else if (kind === 'service') {
      if (!serviceSelected()) {
        showError('Please select a service.');
        return false;
      }
    } else if (kind === 'schedule') {
      if (!scheduleSelected()) {
        showError('Please pick a day and time.');
        return false;
      }
    } else if (kind === 'details') {
      if (!validateDetails()) {
        showError('Please fill in the required fields.');
        return false;
      }
    }
    return true;
  }
  function goNext() {
    if (!canAdvance()) return;
    if (step < maxStep) {
      step += 1;
      renderStep();
    }
  }
  function goBack() {
    showError('');
    if (step > 0) {
      step -= 1;
      renderStep();
    }
  }

  // Staff cards
  var staffCards = fm.querySelectorAll('[data-cal-staff]');
  for (var sc = 0; sc < staffCards.length; sc++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        var slug = btn.getAttribute('data-cal-staff') || '';
        var name = btn.getAttribute('data-cal-staff-name') || slug;
        if (staffInput) staffInput.value = slug;
        if (staffNameInput) staffNameInput.value = name;
        if (slug) {
          tenant._activeProvider = tenant._activeProvider || {};
          tenant._activeProvider.memberSlug = slug;
          tenant._activeProvider.displayName = name;
        }
        for (var i = 0; i < staffCards.length; i++) {
          var on = staffCards[i] === btn;
          staffCards[i].classList.toggle('is-active', on);
          staffCards[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        showError('');
      });
    })(staffCards[sc]);
  }
  // Service cards
  var svcCards = fm.querySelectorAll('[data-cal-service-id]');
  for (var sv = 0; sv < svcCards.length; sv++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        var id = btn.getAttribute('data-cal-service-id') || '';
        var name = btn.getAttribute('data-cal-service-name') || '';
        var slug = btn.getAttribute('data-cal-service-slug') || '';
        if (serviceInput) {
          serviceInput.value = id;
          serviceInput.setAttribute('data-name', name);
          serviceInput.setAttribute('data-slug', slug);
        }
        for (var i = 0; i < svcCards.length; i++) {
          var on = svcCards[i] === btn;
          svcCards[i].classList.toggle('is-active', on);
          svcCards[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        showError('');
      });
    })(svcCards[sv]);
  }

  if (nextBtn) nextBtn.addEventListener('click', function(e) {
    e.preventDefault();
    goNext();
  });
  if (backBtn) backBtn.addEventListener('click', function(e) {
    e.preventDefault();
    goBack();
  });

  // Seed preselected staff/service
  if (staffInput && staffInput.value && tenant) {
    tenant._activeProvider = tenant._activeProvider || {};
    tenant._activeProvider.memberSlug = staffInput.value;
    if (staffNameInput && staffNameInput.value) {
      tenant._activeProvider.displayName = staffNameInput.value;
    }
  }
  renderStep();
}

function guidedBookingInlineStyle(tenant) {
  var parts = [];
  var tc = tenantColors(tenant);
  var fg = tc.fg;
  var accent = tc.accent;
  var surface = pickTenantHex(tenant.bookingFormCardBackgroundColor, tc.card);
  if (isBladeTheme(tenant)) {
    parts.push('--bk-border:rgba(245,240,232,0.15)');
    parts.push('--bk-muted:rgba(245,240,232,0.55)');
    parts.push('--bk-input-bg:rgba(245,240,232,0.06)');
    parts.push('--bk-surface-2:rgba(245,240,232,0.04)');
    parts.push('--bk-shadow:rgba(0,0,0,0.35)');
  } else if (isStonecutTheme(tenant)) {
    parts.push('--bk-border:rgba(232,224,208,0.15)');
    parts.push('--bk-muted:rgba(232,224,208,0.55)');
    parts.push('--bk-input-bg:rgba(232,224,208,0.06)');
    parts.push('--bk-surface-2:rgba(232,224,208,0.04)');
    parts.push('--bk-shadow:rgba(0,0,0,0.4)');
  }
  if (fg) parts.push('--bk-fg:' + fg);
  if (accent) {
    parts.push('--bk-accent:' + accent);
    parts.push('--bk-accent-hover:' + tc.accentHover);
    parts.push('--bk-accent-fg:' + tc.accentFg);
  }
  if (surface) {
    parts.push('--bk-surface:' + surface);
    parts.push('--bk-surface-active:rgba(128,128,128,0.08)');
  }
  if (!parts.some(function(p) { return p.indexOf('--bk-border') === 0; })) {
    parts.push('--bk-border:rgba(0,0,0,0.12)');
  }
  if (!parts.some(function(p) { return p.indexOf('--bk-muted') === 0; })) {
    parts.push('--bk-muted:rgba(0,0,0,0.5)');
  }
  if (!parts.some(function(p) { return p.indexOf('--bk-input-bg') === 0; })) {
    parts.push('--bk-input-bg:rgba(0,0,0,0.04)');
  }
  if (!parts.some(function(p) { return p.indexOf('--bk-surface-2') === 0; })) {
    parts.push('--bk-surface-2:rgba(0,0,0,0.03)');
  }
  if (!parts.some(function(p) { return p.indexOf('--bk-shadow') === 0; })) {
    parts.push('--bk-shadow:rgba(0,0,0,0.08)');
  }
  return parts.join(';');
}

function guidedSectionKeyForField(f) {
  var key = f.key || '';
  if (key === 'service') return 'service';
  if (key === 'name' || key === 'email' || key === 'phone') return 'contact';
  if (key === 'preferredDays' || key === 'preferredTime' || key === 'preferredTimeOfDay') return 'schedule';
  if (key === 'notes' || key === 'referenceImages') return 'details';
  return 'other';
}

function guidedSectionLabel(sectionKey) {
  var labels = {
    service: 'Select service',
    contact: 'Your details',
    schedule: 'Availability',
    details: 'Project details',
    other: 'Additional information'
  };
  return labels[sectionKey] || 'Additional information';
}

function guidedServiceMetaLine(s) {
  var bits = [];
  if (typeof s.price === 'number' && s.price > 0) {
    bits.push('From $' + Number(s.price).toFixed(0));
  } else if (s.priceLabel) {
    bits.push(String(s.priceLabel));
  } else {
    bits.push('Book for pricing');
  }
  if (s.durationMinutes) bits.push(s.durationMinutes + ' min');
  return bits.join(' · ');
}

function guidedFieldHtml(f, services, presel) {
  var key = f.key || '';
  var keySafe = key.replace(/[^a-zA-Z0-9_]/g, '');
  var name = 'f_' + keySafe;
  var req = f.required ? ' required' : '';
  var label = esc(f.label || key);
  if (key === 'service') {
    var initVal = presel ? presel.id : '';
    var cards = (services || []).map(function(s) {
      var active = (presel && presel.id === s.id) ? ' is-active' : '';
      return '<button type="button" class="booking-guided-service-card' + active + '" data-guided-service-id="' + esc(s.id) + '" data-guided-service-name="' + esc(s.name) + '" aria-pressed="' + (active ? 'true' : 'false') + '">' +
        '<p class="name">' + esc(s.name) + '</p>' +
        '<p class="meta">' + esc(guidedServiceMetaLine(s)) + '</p>' +
      '</button>';
    }).join('');
    return '<input type="hidden" id="' + name + '" name="' + name + '" data-key="service" value="' + esc(initVal) + '"' + req + '>' +
      '<div class="booking-guided-service-grid" data-guided-service-grid role="group" aria-label="Services">' + cards + '</div>';
  }
  if (key === 'preferredTime' || key === 'preferredTimeOfDay') {
    var times = ['Morning', 'Afternoon', 'Night', 'Flexible'];
    var pills = times.map(function(t) {
      return '<span class="booking-guided-pill" role="button" tabindex="0" data-pill-value="' + esc(t) + '">' + esc(t) + '</span>';
    }).join('');
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<div class="booking-guided-pill-row" data-guided-pills data-pill-single="true" data-pill-target="' + name + '">' + pills + '</div>' +
      '<input type="hidden" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-field-label="' + esc(f.label || key) + '" value=""' + req + '>';
  }
  if (key === 'preferredDays') {
    var days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var dayPills = days.map(function(d) {
      return '<span class="booking-guided-pill" role="button" tabindex="0" data-pill-value="' + d + '">' + d + '</span>';
    }).join('');
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<div class="booking-guided-pill-row" data-guided-pills data-pill-multi="true" data-pill-target="' + name + '">' + dayPills + '</div>' +
      '<input type="hidden" id="' + name + '" name="' + name + '" data-key="preferredDays" value=""' + req + '>';
  }
  if (key === 'referenceImages') {
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<div class="booking-guided-upload upload-drop" data-reference-images-drop tabindex="0" role="button" aria-label="Upload reference images or PDFs">' +
        '<div class="booking-guided-upload-icon" aria-hidden="true">↑</div>' +
        '<p class="booking-guided-upload-text">Drop photos or PDFs here</p>' +
        '<p class="booking-guided-upload-sub">or tap to choose files</p>' +
        '<div class="upload-drop-filelist" data-upload-filelist style="font-size:11px;margin-top:6px"></div>' +
        '<input type="file" accept="image/*,application/pdf" multiple id="' + name + '" name="' + name + '" data-key="referenceImages" data-type="file" class="upload-drop-input">' +
      '</div>';
  }
  if (f.type === 'select' && (f.options || []).length) {
    var opts = f.options || [];
    var optPills = opts.map(function(o) {
      return '<span class="booking-guided-pill" role="button" tabindex="0" data-pill-value="' + esc(o) + '">' + esc(o) + '</span>';
    }).join('');
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<div class="booking-guided-pill-row" data-guided-pills data-pill-single="true" data-pill-target="' + name + '">' + optPills + '</div>' +
      '<input type="hidden" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-field-label="' + esc(f.label || key) + '" value=""' + req + '>';
  }
  if (f.type === 'boolean') {
    var boolPills = ['yes', 'no'].map(function(v) {
      return '<span class="booking-guided-pill" role="button" tabindex="0" data-pill-value="' + v + '">' + (v === 'yes' ? 'Yes' : 'No') + '</span>';
    }).join('');
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<div class="booking-guided-pill-row" data-guided-pills data-pill-single="true" data-pill-target="' + name + '">' + boolPills + '</div>' +
      '<input type="hidden" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-field-label="' + esc(f.label || key) + '" value=""' + req + '>';
  }
  if (f.type === 'file') {
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<input type="file" accept="image/*,application/pdf" multiple id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-type="file" class="field-input"' + req + '>';
  }
  if (f.type === 'textarea') {
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<textarea class="field-input" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" placeholder="' + esc(f.placeholder || f.label || key) + '"' + req + '></textarea>';
  }
  if (f.type === 'select') {
    var firstOpt = '<option value="">' + esc(f.placeholder || ('Select ' + (f.label || key))) + '</option>';
    var oo = (f.options || []).map(function(o) { return '<option value="' + esc(o) + '">' + esc(o) + '</option>'; }).join('');
    return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
      '<select class="field-input" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '"' + req + '>' + firstOpt + oo + '</select>';
  }
  var typ = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
  return '<label class="booking-guided-field-label" for="' + name + '">' + label + '</label>' +
    '<input class="field-input" type="' + typ + '" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-field-label="' + esc(f.label || key) + '" placeholder="' + esc(f.placeholder || f.label || key) + '"' + req + bookingNameFieldAttrs(f) + '>';
}

function formGuidedFieldsHtml(fields, services, presel, skipService) {
  var html = '';
  var lastSection = '';
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (skipService && f.key === 'service') continue;
    var sec = guidedSectionKeyForField(f);
    if (sec !== lastSection) {
      if (html) html += '<div class="booking-guided-divider"></div>';
      html += '<p class="booking-guided-section-label">' + esc(guidedSectionLabel(sec)) + '</p>';
      lastSection = sec;
    }
    if (f.key === 'service') {
      html += guidedFieldHtml({ key: 'service', label: 'Service', type: 'select', required: true }, services, presel);
    } else {
      html += guidedFieldHtml(f, services, presel);
    }
  }
  return html;
}

function guidedWizardBucketForField(f) {
  var key = (f && f.key) || '';
  if (key === 'service') return 'service';
  if (key === 'name' || key === 'email' || key === 'phone') return 'contact';
  return 'project';
}

function formGuidedProjectFieldsHtml(projectFields, services, presel) {
  if (!projectFields || !projectFields.length) return '';
  var inner = projectFields.map(function(f) {
    return guidedFieldHtml(f, services, presel);
  }).join('');
  return '<p class="booking-guided-section-label">' + esc(guidedSectionLabel('details')) + '</p>' +
    '<div class="booking-guided-project-fields">' + inner + '</div>';
}

function guidedWizardPanelPhase(phase) {
  if (phase === 'project-primary' || phase === 'project-optional') return 'project';
  return phase;
}

function guidedFieldInputName(f) {
  var key = f.key || '';
  return 'f_' + key.replace(/[^a-zA-Z0-9_]/g, '');
}

function guidedMobileChoiceRowsHtml(f) {
  var key = f.key || '';
  var name = guidedFieldInputName(f);
  var req = f.required ? ' required' : '';
  var opts = f.options || [];
  var rows = opts.map(function(o) {
    return '<button type="button" class="booking-guided-choice-row" data-guided-choice-value="' + esc(o) + '" aria-pressed="false">' +
      '<span class="booking-guided-choice-label">' + esc(o) + '</span>' +
      '<span class="booking-guided-choice-check" aria-hidden="true"></span>' +
    '</button>';
  }).join('');
  return '<input type="hidden" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-field-label="' + esc(f.label || key) + '" value=""' + req + '>' +
    '<div class="booking-guided-choice-list" data-guided-choice-list data-choice-target="' + name + '" role="radiogroup" aria-label="' + esc(f.label || key) + '">' +
      rows +
    '</div>';
}

function guidedOptionalFieldHiddenHtml(f) {
  var key = f.key || '';
  var name = guidedFieldInputName(f);
  return '<input type="hidden" id="' + name + '" name="' + name + '" data-key="' + esc(key) + '" data-field-label="' + esc(f.label || key) + '" value="">';
}

function guidedOptionalAddonRowHtml(f) {
  var label = esc(f.label || f.key || 'Details');
  return '<button type="button" class="booking-guided-optional-row" data-guided-optional-row data-optional-key="' + esc(f.key || '') + '">' +
    '<span class="booking-guided-optional-label">' + label + '</span>' +
    '<span class="booking-guided-optional-value" data-guided-optional-summary hidden></span>' +
    '<span class="booking-guided-optional-action">+ add</span>' +
  '</button>' +
  guidedOptionalFieldHiddenHtml(f);
}

function guidedSheetFieldBodyHtml(f) {
  var key = f.key || '';
  var name = guidedFieldInputName(f);
  if (f.type === 'select' && (f.options || []).length) {
    var opts = f.options || [];
    var rows = opts.map(function(o) {
      return '<button type="button" class="booking-guided-choice-row" data-guided-choice-value="' + esc(o) + '" aria-pressed="false">' +
        '<span class="booking-guided-choice-label">' + esc(o) + '</span>' +
        '<span class="booking-guided-choice-check" aria-hidden="true"></span>' +
      '</button>';
    }).join('');
    return '<div class="booking-guided-choice-list" data-guided-choice-list data-choice-target="' + name + '" role="radiogroup">' + rows + '</div>';
  }
  if (f.type === 'textarea') {
    return '<textarea class="field-input" id="' + name + '_sheet" data-sheet-input data-key="' + esc(key) + '" placeholder="' + esc(f.placeholder || f.label || '') + '"></textarea>';
  }
  if (f.type === 'file') {
    return '<div class="booking-guided-upload upload-drop" data-reference-images-drop tabindex="0" role="button">' +
      '<p class="booking-guided-upload-text">Tap to choose photos or PDFs</p>' +
      '<div class="upload-drop-filelist" data-upload-filelist style="font-size:11px;margin-top:6px"></div>' +
      '<input type="file" accept="image/*,application/pdf" multiple id="' + name + '_sheet" data-sheet-file data-key="' + esc(key) + '" data-type="file" class="upload-drop-input">' +
    '</div>';
  }
  var typ = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
  return '<input class="field-input" type="' + typ + '" id="' + name + '_sheet" data-sheet-input data-key="' + esc(key) + '" placeholder="' + esc(f.placeholder || f.label || '') + '">';
}

function formGuidedProjectMobileHtml(projectFields, services, presel) {
  var split = splitProjectFieldsForMobileWizard(projectFields);
  if (!split.useMobileSplit) {
    return { useMobileSplit: false, legacyHtml: formGuidedProjectFieldsHtml(projectFields, services, presel) };
  }
  var primaryLabel = (split.primary.label || 'Your preferences').toString();
  var sectionUpper = primaryLabel.toUpperCase();
  var primaryHtml =
    '<div class="booking-guided-mobile-primary" data-guided-project-primary>' +
      '<h2 class="booking-guided-mobile-title">Your cut</h2>' +
      '<p class="booking-guided-mobile-sub" data-guided-service-subtitle>Select a service first</p>' +
      '<p class="booking-guided-section-label">' + esc(sectionUpper) + '</p>' +
      guidedMobileChoiceRowsHtml(split.primary) +
    '</div>';
  var optionalRows = split.optional.map(function(f) {
    return guidedOptionalAddonRowHtml(f);
  }).join('');
  var optionalHtml =
    '<div class="booking-guided-mobile-optional" data-guided-project-optional>' +
      '<h2 class="booking-guided-mobile-title">Anything else?</h2>' +
      '<p class="booking-guided-mobile-sub">All optional — skip if you\'re good</p>' +
      '<div class="booking-guided-optional-rows">' + optionalRows + '</div>' +
    '</div>';
  return {
    useMobileSplit: true,
    primaryHtml: primaryHtml,
    optionalHtml: optionalHtml,
    projectFields: projectFields
  };
}

function guidedFieldSheetHtml() {
  return '<div class="booking-guided-sheet" data-guided-field-sheet hidden>' +
    '<button type="button" class="booking-guided-sheet-backdrop" data-guided-sheet-close aria-label="Close"></button>' +
    '<div class="booking-guided-sheet-panel">' +
      '<h3 class="booking-guided-sheet-title" data-guided-sheet-title></h3>' +
      '<div data-guided-sheet-body></div>' +
      '<button type="button" class="booking-guided-sheet-done" data-guided-sheet-done>Done</button>' +
    '</div>' +
  '</div>';
}

function formGuidedWizardPanelsHtml(fields, services, presel) {
  var ordered = guidedWizardOrderedFields(fields);
  var panels = [];
  var stepNum = 0;
  function addPanel(phase, innerHtml, extraClass) {
    stepNum += 1;
    panels.push(
      '<div class="booking-guided-step-panel' + (extraClass ? ' ' + extraClass : '') + (stepNum === 1 ? ' is-active' : '') + '"' +
      ' data-guided-step="' + stepNum + '" data-guided-phase="' + phase + '"' +
      (stepNum > 1 ? ' hidden' : '') + '>' + innerHtml + '</div>'
    );
  }
  addPanel('service',
    '<p class="booking-guided-section-label">' + esc(guidedSectionLabel('service')) + '</p>' +
    guidedFieldHtml({ key: 'service', label: 'Service', type: 'select', required: true }, services, presel)
  );
  var mobileProject = ordered.project.length
    ? formGuidedProjectMobileHtml(ordered.project, services, presel)
    : { useMobileSplit: false };
  if (ordered.project.length) {
    if (mobileProject.useMobileSplit) {
      addPanel('project-primary', mobileProject.primaryHtml, 'booking-guided-step-panel--project booking-guided-step-panel--project-mobile');
      addPanel('project-optional', mobileProject.optionalHtml, 'booking-guided-step-panel--project booking-guided-step-panel--project-mobile');
    } else {
      addPanel('project', formGuidedProjectFieldsHtml(ordered.project, services, presel), 'booking-guided-step-panel--project');
    }
  }
  if (ordered.contact.length) {
    var contactFields = ordered.contact.filter(function(cf) { return cf.key !== 'phone'; });
    var contactInner = '<p class="booking-guided-section-label">' + esc(guidedSectionLabel('contact')) + '</p>' +
      '<div class="booking-guided-contact-fields">' +
      contactFields.map(function(cf) { return guidedFieldHtml(cf, services, presel); }).join('') +
      '</div>';
    addPanel('contact', contactInner, 'booking-guided-step-panel--contact');
  }
  addPanel('confirm',
    '<p class="booking-guided-section-label">Review your request</p>' +
    '<div class="booking-guided-summary" data-guided-summary></div>'
  );
  return {
    html: panels.join(''),
    totalSteps: stepNum,
    confirmStep: stepNum
  };
}

function guidedWizardProgressHtml(totalSteps) {
  var segs = [];
  for (var s = 0; s < totalSteps; s++) {
    segs.push('<span class="booking-guided-prog-seg' + (s === 0 ? ' is-active' : '') + '"></span>');
  }
  return segs.join('');
}

function guidedStepDefaultTitle(tenant, key) {
  var industry = String((tenant && tenant.industry) || 'custom').trim().toLowerCase();
  var defaults = {
    custom: { service: 'Service', project: 'Project details', contact: 'About you', confirm: 'Confirm' },
    barber: { service: 'Service', project: 'Cut', contact: 'You', confirm: 'Confirm' },
    hair: { service: 'Service', project: 'Style', contact: 'You', confirm: 'Confirm' },
    tattoos: { service: 'Service', project: 'Design', contact: 'You', confirm: 'Confirm' },
    nails: { service: 'Service', project: 'Details', contact: 'You', confirm: 'Confirm' },
    charters: { service: 'Service', project: 'Trip details', contact: 'About you', confirm: 'Confirm' }
  };
  var map = defaults[industry] || defaults.custom;
  return map[key] || defaults.custom[key] || key;
}

function guidedStepTitle(tenant, key) {
  var titles = tenant && tenant.guidedStepTitles;
  if (titles && typeof titles === 'object' && titles[key]) {
    var t = String(titles[key]).trim();
    if (t) return esc(t);
  }
  return esc(guidedStepDefaultTitle(tenant, key));
}

function guidedWizardPhaseChromeHtml(tenant) {
  return '' +
    '<div class="booking-guided-steps" data-guided-wizard-steps role="navigation" aria-label="Booking steps">' +
      '<div class="booking-guided-step-labels booking-guided-phase-labels">' +
        '<span data-guided-phase-label="service" class="is-active">' + guidedStepTitle(tenant, 'service') + '</span>' +
        '<span data-guided-phase-label="project">' + guidedStepTitle(tenant, 'project') + '</span>' +
        '<span data-guided-phase-label="contact">' + guidedStepTitle(tenant, 'contact') + '</span>' +
        '<span data-guided-phase-label="confirm">' + guidedStepTitle(tenant, 'confirm') + '</span>' +
      '</div>' +
      '<div class="booking-guided-step-row booking-guided-phase-dots">' +
        '<span class="booking-guided-step-dot" data-guided-phase-dot="service">1</span>' +
        '<span class="booking-guided-step-line"></span>' +
        '<span class="booking-guided-step-dot is-inactive" data-guided-phase-dot="project">2</span>' +
        '<span class="booking-guided-step-line"></span>' +
        '<span class="booking-guided-step-dot is-inactive" data-guided-phase-dot="contact">3</span>' +
        '<span class="booking-guided-step-line"></span>' +
        '<span class="booking-guided-step-dot is-inactive" data-guided-phase-dot="confirm">4</span>' +
      '</div>' +
    '</div>';
}

function humanizeFormFieldKey(key) {
  var s = (key || '').replace(/_/g, ' ');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return s.split(/\s+/).filter(Boolean).map(function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function formFieldLabelFromSchema(fm, key) {
  var enc = fm.getAttribute('data-guided-form-schema-encoded');
  if (enc) {
    try {
      var schemaFields = JSON.parse(decodeURIComponent(enc));
      for (var i = 0; i < schemaFields.length; i++) {
        if (schemaFields[i].key === key && schemaFields[i].label) {
          return String(schemaFields[i].label).trim();
        }
      }
    } catch (e) { /* ignore */ }
  }
  var low = (key || '').toLowerCase();
  if (FORM_FIELD_DISPLAY_LABELS[low]) return FORM_FIELD_DISPLAY_LABELS[low];
  return humanizeFormFieldKey(key);
}

function guidedWizardFieldLabel(fm, key) {
  var safeKey = (key || '').replace(/"/g, '');
  var el = fm.querySelector('[data-key="' + safeKey + '"]');
  if (el) {
    var attrLabel = el.getAttribute('data-field-label');
    if (attrLabel && attrLabel.trim()) return attrLabel.trim();
    var id = el.id;
    if (id) {
      var lab = fm.querySelector('label[for="' + id + '"]');
      if (lab && (lab.textContent || '').trim()) return (lab.textContent || '').trim();
    }
    var optRow = fm.querySelector('[data-guided-optional-row][data-optional-key="' + safeKey + '"] .booking-guided-optional-label');
    if (optRow && (optRow.textContent || '').trim()) return (optRow.textContent || '').trim();
  }
  return formFieldLabelFromSchema(fm, safeKey);
}

function guidedWizardRenderSummary(fm) {
  var summaryEl = fm.querySelector('[data-guided-summary]');
  if (!summaryEl) return;
  var rows = [];
  var activeCard = fm.querySelector('.booking-guided-service-card.is-active');
  if (activeCard) {
    var nameEl = activeCard.querySelector('.name');
    if (nameEl) rows.push({ label: 'Service', value: (nameEl.textContent || '').trim() });
  }
  var fileKeys = {};
  fm.querySelectorAll('input[data-type="file"]').forEach(function(inp) {
    var k = inp.getAttribute('data-key');
    if (k && inp.files && inp.files.length) fileKeys[k] = inp.files.length;
  });
  fm.querySelectorAll('[data-key]').forEach(function(el) {
    if (el.getAttribute('data-type') === 'file') return;
    var k = el.getAttribute('data-key');
    if (!k || k === 'service') return;
    var v = (el.value || '').trim();
    if (!v && !fileKeys[k]) return;
    if (fileKeys[k]) {
      rows.push({ label: guidedWizardFieldLabel(fm, k), value: fileKeys[k] + ' file(s)' });
      return;
    }
    rows.push({ label: guidedWizardFieldLabel(fm, k), value: v });
  });
  if (!rows.length) {
    summaryEl.innerHTML = '<p class="booking-guided-summary-value" style="text-align:left;font-weight:400;color:var(--bk-muted,rgba(0,0,0,0.5))">No details entered yet.</p>';
    return;
  }
  summaryEl.innerHTML = rows.map(function(r) {
    return '<div class="booking-guided-summary-row">' +
      '<span class="booking-guided-summary-label">' + esc(r.label) + '</span>' +
      '<span class="booking-guided-summary-value">' + esc(r.value) + '</span>' +
    '</div>';
  }).join('');
}

function guidedWizardValidateStep(fm, step, errEl) {
  function showErr(msg) {
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = 'block';
    }
  }
  if (errEl) errEl.style.display = 'none';
  var panel = fm.querySelector('[data-guided-step="' + step + '"]');
  if (!panel) return true;
  var phase = panel.getAttribute('data-guided-phase') || '';
  if (phase === 'service') {
    var svc = fm.querySelector('[data-key="service"]');
    if (!svc || !(svc.value || '').trim()) {
      showErr('Please select a service to continue.');
      return false;
    }
    return true;
  }
  if (phase === 'confirm') return true;
  if (phase === 'project-optional') return true;
  if (phase === 'project-primary') {
    var primaryHidden = panel.querySelector('input[data-key]');
    if (primaryHidden && !(primaryHidden.value || '').trim()) {
      showErr('Please choose an option to continue.');
      return false;
    }
    return true;
  }
  var inputs = panel.querySelectorAll('input, select, textarea');
  for (var i = 0; i < inputs.length; i++) {
    var inp = inputs[i];
    if (inp.type === 'hidden' || inp.type === 'file') continue;
    if (!inp.checkValidity()) {
      inp.reportValidity();
      return false;
    }
  }
  return true;
}

function guidedPanelNeedsContinueBtn(panel) {
  if (!panel) return true;
  var phase = panel.getAttribute('data-guided-phase') || '';
  if (phase === 'confirm') return false;
  if (phase === 'service') return false;
  return true;
}

function formSchemaPhoneMeta(fm) {
  var label = 'Mobile phone';
  var placeholder = '(555) 123-4567';
  var required = true;
  try {
    var enc = fm.getAttribute('data-guided-form-schema-encoded');
    if (enc) {
      var fields = JSON.parse(decodeURIComponent(enc));
      for (var i = 0; i < fields.length; i++) {
        if (fields[i].key === 'phone') {
          if (fields[i].label) label = String(fields[i].label);
          if (fields[i].placeholder) placeholder = String(fields[i].placeholder);
          required = fields[i].required !== false;
          break;
        }
      }
    }
  } catch (e) { /* ignore */ }
  return { label: label, placeholder: placeholder, required: required };
}

function bookingSmsConsentAnchor(fm) {
  var wizardFooter = fm.querySelector('.booking-guided-wizard-footer');
  if (wizardFooter) {
    return wizardFooter.querySelector('#form-error') || wizardFooter;
  }
  return fm.querySelector('#form-error') ||
    fm.querySelector('button[type="submit"]') ||
    fm;
}

/** Shops with "Deposit to confirm": the client pays the deposit right after booking. */
function siteNeedsDepositAtBooking(tenant) {
  var w = (tenant && tenant.workflow) || {};
  var plan = String((tenant && tenant.subscriptionPlan) || '').toLowerCase();
  return plan !== 'charter' && String(w.confirmationType || '').toLowerCase() === 'deposit_to_confirm';
}

function siteDepositDollarsFor(tenant, service) {
  var w = (tenant && tenant.workflow) || {};
  if (w.depositPerService === true && service && Number(service.depositAmount) > 0) return Number(service.depositAmount);
  return Number(w.depositAmount) > 0 ? Number(w.depositAmount) : 0;
}

/** Note above the submit button ("A $50 deposit confirms your appointment…") that follows the picked service. */
function injectBookingDepositNote(fm, tenant, services) {
  if (!fm || !siteNeedsDepositAtBooking(tenant)) return;
  if (fm.querySelector('[data-deposit-note]')) return;
  var btn = fm.querySelector('button[type="submit"]');
  if (!btn) return;
  var note = document.createElement('p');
  note.className = 'booking-deposit-note';
  note.setAttribute('data-deposit-note', '');
  note.style.cssText = 'margin:12px 0 8px;font-size:14px;line-height:1.5;opacity:.85;';
  btn.parentNode.insertBefore(note, btn);
  var baseLabel = btn.textContent;
  function pickedService() {
    var sel = fm.querySelector('[data-key="service"]');
    var id = sel ? sel.value : '';
    var list = services || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function paint() {
    var dollars = siteDepositDollarsFor(tenant, pickedService());
    if (dollars >= 0.5) {
      var amt = '$' + (Number.isInteger(dollars) ? dollars : dollars.toFixed(2));
      note.textContent = 'A ' + amt + ' deposit confirms your appointment. You\u2019ll pay it securely on the next screen.';
      note.style.display = '';
      btn.textContent = 'Continue to deposit';
    } else {
      note.style.display = 'none';
      btn.textContent = baseLabel;
    }
  }
  fm.addEventListener('change', function (ev) {
    if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-key') === 'service') paint();
  });
  paint();
}

function injectBookingSmsConsent(fm, tenant) {
  if (!fm || !tenant) return;
  if (fm.querySelector('[data-sms-consent]')) return;
  var hasPhoneInSchema = !!fm.querySelector('[data-key="phone"]') ||
    (function() {
      try {
        var enc = fm.getAttribute('data-guided-form-schema-encoded');
        if (!enc) return true;
        var fields = JSON.parse(decodeURIComponent(enc));
        return fields.some(function(f) { return f.key === 'phone'; });
      } catch (e) { return true; }
    })();
  if (!hasPhoneInSchema) return;
  var biz = esc((tenant.businessName || tenant.displayName || 'this business').toString());
  var block = document.createElement('div');
  block.className = 'booking-sms-consent';
  block.setAttribute('data-sms-consent', '');
  block.innerHTML =
    '<label class="booking-sms-consent-label">' +
      '<input type="checkbox" data-sms-consent-checkbox />' +
      '<span>I agree to receive appointment-related text messages from ' + biz +
      ' at this mobile number. Message and data rates may apply. Reply STOP to opt out. ' +
      '<a href="' + BOOK_PRIVACY_URL + '" target="_blank" rel="noopener noreferrer">Privacy</a> · ' +
      '<a href="' + BOOK_TERMS_URL + '" target="_blank" rel="noopener noreferrer">Terms</a>.' +
      '</span>' +
    '</label>';
  var isCalWizard = fm.hasAttribute('data-cal-wizard-form');
  if (!isCalWizard) {
    ensurePhoneInSmsConsentBox(fm, block);
  }
  var anchor = bookingSmsConsentAnchor(fm);
  if (anchor && anchor.parentNode) {
    anchor.parentNode.insertBefore(block, anchor);
  } else {
    fm.appendChild(block);
  }
  if (fm.hasAttribute('data-guided-wizard-form')) {
    block.setAttribute('data-sms-consent-wizard', '1');
    block.hidden = true;
  }
  if (isCalWizard) {
    block.setAttribute('data-sms-consent-cal', '1');
    block.hidden = true;
  }
  if (tenantClientSmsActive(tenant)) {
    var depositNote = fm.querySelector('[data-guided-deposit-note]');
    if (depositNote) depositNote.setAttribute('data-sms-gated', 'on');
  }
}

function setupGuidedBookingForm(fm, initDropzonesFn) {
  if (!fm || !fm.classList.contains('booking-form--guided')) return;
  var wizardActive = fm.hasAttribute('data-guided-wizard-form');
  var wrap = wizardActive ? fm.closest('.booking-guided--wizard') : null;
  var stepsRoot = wrap ? wrap.querySelector('[data-guided-wizard-steps]') : null;
  var panels = wizardActive ? fm.querySelectorAll('[data-guided-step]') : [];
  var backBtn = fm.querySelector('[data-guided-back]');
  var nextBtn = fm.querySelector('[data-guided-next]');
  var submitBtn = fm.querySelector('[data-guided-submit]');
  var depositNote = fm.querySelector('[data-guided-deposit-note]');
  var errEl = document.getElementById('form-error');
  var confirmStep = wizardActive ? parseInt(fm.getAttribute('data-guided-confirm-step') || '1', 10) : 1;
  var phaseOrder = ['service', 'project', 'contact', 'confirm'];
  var currentStep = 1;
  var tryAdvanceAfterSelection = null;
  function phaseIndex(phase) {
    var idx = phaseOrder.indexOf(phase);
    return idx >= 0 ? idx : 0;
  }
  function updateStepChrome(step) {
    if (!wizardActive) return;
    var panel = fm.querySelector('[data-guided-step="' + step + '"]');
    var phase = panel ? (panel.getAttribute('data-guided-phase') || 'service') : 'service';
    var pIdx = phaseIndex(guidedWizardPanelPhase(phase));
    var phaseLabels = stepsRoot ? stepsRoot.querySelectorAll('[data-guided-phase-label]') : [];
    var phaseDots = stepsRoot ? stepsRoot.querySelectorAll('[data-guided-phase-dot]') : [];
    for (var li = 0; li < phaseLabels.length; li++) {
      var pl = phaseLabels[li].getAttribute('data-guided-phase-label');
      var plIdx = phaseIndex(pl);
      phaseLabels[li].classList.toggle('is-active', plIdx === pIdx);
      phaseLabels[li].classList.toggle('is-done', plIdx < pIdx);
    }
    for (var di = 0; di < phaseDots.length; di++) {
      var pd = phaseDots[di].getAttribute('data-guided-phase-dot');
      var pdIdx = phaseIndex(pd);
      phaseDots[di].classList.toggle('is-inactive', pdIdx > pIdx);
    }
  }
  function showStep(step) {
    if (!wizardActive) return;
    currentStep = step;
    fm.dataset.guidedStep = String(step);
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      var pn = parseInt(p.getAttribute('data-guided-step'), 10);
      var on = pn === step;
      p.hidden = !on;
      p.classList.toggle('is-active', on);
    }
    updateStepChrome(step);
    var activePanel = fm.querySelector('[data-guided-step="' + step + '"]');
    var activePhase = activePanel ? (activePanel.getAttribute('data-guided-phase') || '') : '';
    var needsContinue = guidedPanelNeedsContinueBtn(activePanel);
    var skipBtn = fm.querySelector('[data-guided-skip]');
    if (backBtn) backBtn.hidden = step <= 1;
    if (skipBtn) skipBtn.hidden = activePhase !== 'project-optional';
    if (nextBtn) {
      nextBtn.hidden = step >= confirmStep || !needsContinue;
      nextBtn.textContent = activePhase === 'contact' ? 'Review' : 'Continue';
    }
    if (submitBtn) submitBtn.hidden = step !== confirmStep;
    if (depositNote) {
      var smsGated = depositNote.getAttribute('data-sms-gated') === 'on';
      depositNote.hidden = step !== confirmStep || !smsGated;
    }
    var smsConsentBlock = fm.querySelector('[data-sms-consent][data-sms-consent-wizard]');
    if (smsConsentBlock) smsConsentBlock.hidden = step !== confirmStep;
    if (step === confirmStep) guidedWizardRenderSummary(fm);
    if (errEl) errEl.style.display = 'none';
  }
  tryAdvanceAfterSelection = function() {
    if (!wizardActive) return;
    window.setTimeout(function() {
      if (!guidedWizardValidateStep(fm, currentStep, errEl)) return;
      if (currentStep < confirmStep) showStep(currentStep + 1);
    }, 320);
  };
  if (wizardActive) {
    showStep(1);
    if (backBtn) {
      backBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (currentStep > 1) showStep(currentStep - 1);
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!guidedWizardValidateStep(fm, currentStep, errEl)) return;
        if (currentStep < confirmStep) showStep(currentStep + 1);
      });
    }
    var skipBtn = fm.querySelector('[data-guided-skip]');
    if (skipBtn) {
      skipBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (currentStep < confirmStep) showStep(currentStep + 1);
      });
    }
    fm.addEventListener('submit', function(e) {
      if (currentStep !== confirmStep) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  }
  var serviceHidden = fm.querySelector('[data-key="service"]');
  var grid = fm.querySelector('[data-guided-service-grid]');
  if (grid && serviceHidden) {
    var cards = grid.querySelectorAll('[data-guided-service-id]');
    function activateCard(card, autoAdvance) {
      for (var ci = 0; ci < cards.length; ci++) cards[ci].classList.remove('is-active');
      card.classList.add('is-active');
      serviceHidden.value = card.getAttribute('data-guided-service-id') || '';
      card.setAttribute('aria-pressed', 'true');
      for (var cj = 0; cj < cards.length; cj++) {
        if (cards[cj] !== card) cards[cj].setAttribute('aria-pressed', 'false');
      }
      var nameEl = card.querySelector('.name');
      var subEl = fm.querySelector('[data-guided-service-subtitle]');
      if (subEl && nameEl) {
        subEl.textContent = (nameEl.textContent || '').trim() + ' selected';
      }
      if (autoAdvance && tryAdvanceAfterSelection) tryAdvanceAfterSelection();
    }
    for (var si = 0; si < cards.length; si++) {
      (function(card) {
        card.addEventListener('click', function(e) {
          e.preventDefault();
          activateCard(card, wizardActive);
        });
      })(cards[si]);
    }
    if (!serviceHidden.value && cards.length === 1) activateCard(cards[0], false);
  }

  function setupGuidedChoiceList(list) {
    var targetId = list.getAttribute('data-choice-target');
    var hidden = targetId ? document.getElementById(targetId) : null;
    if (!hidden) return;
    var rows = list.querySelectorAll('.booking-guided-choice-row');
    function setVal(val) {
      hidden.value = val || '';
      for (var ri = 0; ri < rows.length; ri++) {
        var rv = rows[ri].getAttribute('data-guided-choice-value');
        var on = rv === val;
        rows[ri].classList.toggle('is-active', on);
        rows[ri].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    for (var i = 0; i < rows.length; i++) {
      (function(row) {
        row.addEventListener('click', function(e) {
          e.preventDefault();
          setVal(row.getAttribute('data-guided-choice-value'));
        });
      })(rows[i]);
    }
    if (hidden.value) setVal(hidden.value);
  }
  function guidedOptionalRowSummary(f, val, fileCount) {
    if (fileCount) return fileCount + ' file(s)';
    return (val || '').trim();
  }
  function syncOptionalRow(fm, key) {
    var row = fm.querySelector('[data-guided-optional-row][data-optional-key="' + key + '"]');
    var hidden = fm.querySelector('input[data-key="' + key + '"]');
    if (!row || !hidden) return;
    var summaryEl = row.querySelector('[data-guided-optional-summary]');
    var actionEl = row.querySelector('.booking-guided-optional-action');
    var fileInp = fm.querySelector('input[type="file"][data-key="' + key + '"]');
    var fileCount = fileInp && fileInp.files ? fileInp.files.length : 0;
    var summary = guidedOptionalRowSummary(null, hidden.value, fileCount);
    if (summary) {
      row.classList.add('is-filled');
      if (summaryEl) { summaryEl.textContent = summary; summaryEl.hidden = false; }
      if (actionEl) actionEl.textContent = 'edit';
    } else {
      row.classList.remove('is-filled');
      if (summaryEl) { summaryEl.textContent = ''; summaryEl.hidden = true; }
      if (actionEl) actionEl.textContent = '+ add';
    }
  }
  function setupGuidedMobileWizard(fm) {
    var enc = fm.getAttribute('data-guided-project-fields-encoded');
    var projectFieldDefs = [];
    if (enc) {
      try { projectFieldDefs = JSON.parse(decodeURIComponent(enc)); } catch (e) { projectFieldDefs = []; }
    }
    var choiceLists = fm.querySelectorAll('[data-guided-choice-list]');
    for (var ci = 0; ci < choiceLists.length; ci++) setupGuidedChoiceList(choiceLists[ci]);
    var sheet = document.querySelector('[data-guided-field-sheet]');
    if (!sheet) sheet = fm.parentElement ? fm.parentElement.querySelector('[data-guided-field-sheet]') : null;
    var sheetTitle = sheet ? sheet.querySelector('[data-guided-sheet-title]') : null;
    var sheetBody = sheet ? sheet.querySelector('[data-guided-sheet-body]') : null;
    var activeOptionalKey = null;
    function closeSheet() {
      if (sheet) sheet.hidden = true;
      activeOptionalKey = null;
    }
    function openSheetForField(f) {
      if (!sheet || !sheetBody || !sheetTitle) return;
      activeOptionalKey = f.key;
      sheetTitle.textContent = f.label || f.key;
      sheetBody.innerHTML = guidedSheetFieldBodyHtml(f);
      var lists = sheetBody.querySelectorAll('[data-guided-choice-list]');
      for (var li = 0; li < lists.length; li++) setupGuidedChoiceList(lists[li]);
      if (f.type === 'file' && typeof initDropzonesFn === 'function') {
        initDropzonesFn(sheetBody);
        var mainFile = fm.querySelector('input[type="file"][data-key="' + f.key + '"]');
        var sheetFile = sheetBody.querySelector('[data-sheet-file]');
        if (mainFile && mainFile.files && mainFile.files.length && sheetFile) {
          try {
            var dt = new DataTransfer();
            for (var fi = 0; fi < mainFile.files.length; fi++) dt.items.add(mainFile.files[fi]);
            sheetFile.files = dt.files;
            sheetFile.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (restoreErr) { /* keep empty sheet */ }
        }
      }
      var hidden = fm.querySelector('input[data-key="' + f.key + '"]');
      var sheetInput = sheetBody.querySelector('[data-sheet-input]');
      if (sheetInput && hidden) sheetInput.value = hidden.value || '';
      sheet.hidden = false;
    }
    if (sheet) {
      sheet.querySelectorAll('[data-guided-sheet-close], [data-guided-sheet-done]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          if (!activeOptionalKey) { closeSheet(); return; }
          var key = activeOptionalKey;
          var hidden = fm.querySelector('input[data-key="' + key + '"]');
          var sheetInput = sheetBody.querySelector('[data-sheet-input]');
          var sheetFile = sheetBody.querySelector('[data-sheet-file]');
          if (sheetInput && hidden) hidden.value = sheetInput.value;
          if (sheetFile) {
            var mainFile = fm.querySelector('input[type="file"][data-key="' + key + '"]');
            if (!mainFile) {
              mainFile = document.createElement('input');
              mainFile.type = 'file';
              mainFile.name = sheetFile.name;
              mainFile.id = sheetFile.id.replace('_sheet', '');
              mainFile.setAttribute('data-key', key);
              mainFile.setAttribute('data-type', 'file');
              mainFile.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none';
              fm.appendChild(mainFile);
            }
            try {
              var dt = new DataTransfer();
              if (sheetFile.files) {
                for (var fi = 0; fi < sheetFile.files.length; fi++) dt.items.add(sheetFile.files[fi]);
              }
              mainFile.files = dt.files;
            } catch (err) { /* fallback: user re-picks on main input */ }
          }
          syncOptionalRow(fm, key);
          closeSheet();
        });
      });
      sheet.querySelector('.booking-guided-sheet-backdrop').addEventListener('click', closeSheet);
    }
    var optionalRows = fm.querySelectorAll('[data-guided-optional-row]');
    for (var oi = 0; oi < optionalRows.length; oi++) {
      (function(row) {
        var key = row.getAttribute('data-optional-key');
        row.addEventListener('click', function(e) {
          e.preventDefault();
          var f = null;
          for (var pi = 0; pi < projectFieldDefs.length; pi++) {
            if (projectFieldDefs[pi].key === key) { f = projectFieldDefs[pi]; break; }
          }
          if (f) openSheetForField(f);
        });
        syncOptionalRow(fm, key);
      })(optionalRows[oi]);
    }
  }
  if (fm.hasAttribute('data-guided-mobile-project')) setupGuidedMobileWizard(fm);
  var pillGroups = fm.querySelectorAll('[data-guided-pills]');
  for (var gi = 0; gi < pillGroups.length; gi++) {
    (function(group) {
      var targetId = group.getAttribute('data-pill-target');
      var hidden = targetId ? document.getElementById(targetId) : null;
      if (!hidden) return;
      var multi = group.hasAttribute('data-pill-multi');
      var pills = group.querySelectorAll('.booking-guided-pill');
      function selectedValues() {
        var val = hidden.value || '';
        return val ? val.split(',').map(function(x) { return x.trim(); }).filter(Boolean) : [];
      }
      function syncPills() {
        var sel = selectedValues();
        for (var pi = 0; pi < pills.length; pi++) {
          var pv = pills[pi].getAttribute('data-pill-value');
          pills[pi].classList.toggle('is-active', sel.indexOf(pv) >= 0);
        }
      }
      function setSingle(val) {
        hidden.value = val || '';
        for (var pj = 0; pj < pills.length; pj++) {
          var pval = pills[pj].getAttribute('data-pill-value');
          pills[pj].classList.toggle('is-active', pval === val);
        }
      }
      function toggleMulti(val) {
        var sel = selectedValues();
        var idx = sel.indexOf(val);
        if (idx >= 0) sel.splice(idx, 1);
        else sel.push(val);
        hidden.value = sel.join(',');
        syncPills();
      }
      for (var pk = 0; pk < pills.length; pk++) {
        (function(pill) {
          var val = pill.getAttribute('data-pill-value');
          function onPick(e) {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            if (multi) toggleMulti(val);
            else setSingle(val);
          }
          pill.addEventListener('click', onPick);
          pill.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(e); }
          });
        })(pills[pk]);
      }
      syncPills();
    })(pillGroups[gi]);
  }
}

/** Thank-you view after booking: large business name + confirmation (tattoo matches /book layout). */
function bookingSuccessHtml(tenant) {
  var name = esc(tenantSiteDisplayName(tenant, 'Thank you'));
  var lead = '✓ Request received';
  var detail = 'Thanks for reaching out. We\'ll review your details and get back to you soon.';
  if (isStudio12Theme(tenant)) {
    return '' +
      '<div class="tattoo-page studio12-page studio12-sub" style="' + tenantPageStyle(tenant, 'page') + '">' +
      studio12NavHtml(tenant) +
      '<div class="booking-shell">' +
        '<div class="booking-page-header">' +
          '<h1 class="booking-page-title">' + name + '</h1>' +
        '</div>' +
        '<div class="booking-success-flat">' +
          '<p class="booking-success-lead">' + lead + '</p>' +
          '<p class="booking-success-detail">' + detail + '</p>' +
        '</div>' +
      '</div>' +
      studio12SiteFooterHtml(tenant) +
      studio12SidebarHtml(tenant) +
      '</div>';
  }
  if (usesThemedChrome(tenant)) {
    var base = tenantBaseUrl(tenant);
    var bookUrl = base + '/book';
    var nav = isBladeTheme(tenant)
      ? bladeNavHtml(tenant, base + '/home')
      : (isLuxeTheme(tenant) ? luxeChromeNavHtml(tenant, 'light') : (isStonecutTheme(tenant) ? stonecutNavHtml(tenant) : tattooNavHtml(tenant)));
    var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
      '<div class="tattoo-sidebar-backdrop"></div>' +
      tattooSidebarPanelOpenTag(tenant) +
      tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
      '</div></div>';
    var bookPageStyle = tenantPageStyle(tenant, 'page');
    var successWrapClass = isStonecutTheme(tenant)
      ? 'stonecut-page'
      : ('tattoo-page' +
      (isBladeTheme(tenant) ? ' blade-page blade-page--sub' : '') +
      (isLuxeTheme(tenant) ? ' luxe-page luxe-page--sub' : '') +
      (isClassicTheme(tenant) ? ' classic-home' : ''));
    var successHeaderHtml = '';
    if (!isLuxeTheme(tenant) && !isBladeTheme(tenant) && !isClassicTheme(tenant) && !isStonecutTheme(tenant)) {
      successHeaderHtml =
        '<div class="booking-page-header">' +
          tattooHeadlineLogoHtml(tenant) +
          '<h1 class="booking-page-title">' + name + '</h1>' +
        '</div>';
    }
    var successFooter = '';
    if (isBladeTheme(tenant)) successFooter = bladeSiteFooterHtml(tenant);
    else if (isLuxeTheme(tenant)) successFooter = luxeContactSectionHtml(tenant);
    else if (isStonecutTheme(tenant)) successFooter = stonecutSiteFooterHtml(tenant);
    else if (isClassicTheme(tenant)) successFooter = classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio'));
    if (!successFooter) successFooter = minimalBookLegalFooterHtml(tenant);
    return '' +
      '<div class="' + successWrapClass + '" style="'+bookPageStyle+'">' +
        nav +
        '<div class="booking-shell">' +
          successHeaderHtml +
          '<div class="booking-success-flat">' +
            '<p class="booking-success-lead">' + lead + '</p>' +
            '<p class="booking-success-detail">' + detail + '</p>' +
          '</div>' +
        '</div>' +
        successFooter +
        sidebar +
      '</div>';
  }
  return '<div class="booking-success-generic"><h1 class="booking-success-brand">' + name + '</h1>' +
    '<div class="card"><div class="booking-success-card">' +
    '<p class="booking-success-lead">' + lead + '</p>' +
    '<p class="booking-success-detail">' + detail + '</p>' +
    '</div></div></div>';
}
