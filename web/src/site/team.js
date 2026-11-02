/* Team pages and provider profiles. */

function isTeamPlan(tenant) {
  var p = String((tenant && tenant.subscriptionPlan) || '').toLowerCase();
  return p === 'studio' || p === 'shop' || p === 'growth' || p === 'pro' || p === 'enterprise';
}

function memberProfileUrl(tenant, memberSlug) {
  var base = tenantBaseUrl(tenant).replace(/\/$/, '');
  var ms = String(memberSlug || '').toLowerCase();
  if (!ms) return base + '/home';
  return base + '/team/' + ms;
}

function memberBookUrl(tenant, memberSlug) {
  var base = tenantBaseUrl(tenant).replace(/\/$/, '');
  var ms = String(memberSlug || '').toLowerCase();
  if (!ms) return base + '/book';
  return base + '/book?member=' + encodeURIComponent(ms);
}

function loadPublicProviders(tenantSlug) {
  return functions.httpsCallable('listPublicProviders')({ tenantSlug: tenantSlug })
    .then(function(res) { return (res && res.data && res.data.providers) || []; })
    .catch(function() { return []; });
}

function loadTeamRoster(tenantSlug) {
  return functions.httpsCallable('listTeamRoster')({ tenantSlug: tenantSlug })
    .then(function(res) { return (res && res.data && res.data.members) || []; })
    .catch(function() { return []; });
}

function loadPublicProvider(tenantSlug, memberSlug) {
  return functions.httpsCallable('getPublicProvider')({
    tenantSlug: tenantSlug,
    memberSlug: memberSlug
  }).then(function(res) { return (res && res.data && res.data.provider) || null; });
}

function teamRosterInitials(displayName) {
  var parts = String(displayName || 'P').trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  return String(displayName || 'P').charAt(0).toUpperCase();
}

function teamRosterRoleLabel(provider) {
  var title = (provider.jobTitle || '').toString().trim();
  if (title) return title.toUpperCase();
  if (provider.isOwner) return 'STUDIO OWNER';
  return 'TEAM MEMBER';
}

/** Website-facing member name (override) with identity fallback. */
function teamMemberSiteName(tenant, provider) {
  var real = (provider && provider.displayName) ? String(provider.displayName) : '';
  var slug = String((provider && provider.memberSlug) || '').trim().toLowerCase();
  if (!slug) return real;
  if (webCopyHasExplicit(tenant, 'wc.tm.' + slug + '.name')) {
    var over = webCopyOverrideText(tenant, 'wc.tm.' + slug + '.name', '');
    if (over) return over;
  }
  return real;
}

/** Website-facing role label (override) with identity fallback. */
function teamMemberSiteRole(tenant, provider) {
  var real = teamRosterRoleLabel(provider);
  var slug = String((provider && provider.memberSlug) || '').trim().toLowerCase();
  if (!slug) return real;
  if (webCopyHasExplicit(tenant, 'wc.tm.' + slug + '.role')) {
    var over = webCopyOverrideText(tenant, 'wc.tm.' + slug + '.role', '');
    if (over) return over;
  }
  return real;
}

/** Website-facing bio (override) with identity fallback. */
function teamMemberSiteBio(tenant, provider) {
  var real = (provider && provider.providerAboutText) ? String(provider.providerAboutText).trim() : '';
  var slug = String((provider && provider.memberSlug) || '').trim().toLowerCase();
  if (!slug) return real;
  if (webCopyHasExplicit(tenant, 'wc.tm.' + slug + '.bio')) {
    return webCopyOverrideText(tenant, 'wc.tm.' + slug + '.bio', real);
  }
  return real;
}

function teamRosterCardHtml(tenant, provider, opts) {
  opts = opts || {};
  var profileUrl = memberProfileUrl(tenant, provider.memberSlug);
  var siteName = teamMemberSiteName(tenant, provider);
  var siteRole = teamMemberSiteRole(tenant, provider);
  var thumb = provider.profilePhotoUrl || '';
  var photoInner = thumb
    ? '<img src="' + esc(thumb) + '" alt="">'
    : '<span class="bk-team-roster-initials">' + esc(teamRosterInitials(siteName || provider.displayName)) + '</span>';
  var bio = teamMemberSiteBio(tenant, provider);
  var bioHtml = bio ? '<p class="bk-team-roster-bio">' + esc(bio) + '</p>' : '';
  var bodyInner =
    '<div class="bk-team-roster-photo">' + photoInner + '</div>' +
    '<div class="bk-team-roster-body">' +
    '<h3 class="bk-team-roster-name">' + esc(siteName || '') + '</h3>' +
    '<p class="bk-team-roster-role">' + esc(siteRole) + '</p>' +
    bioHtml +
    '</div>';
  var cardSurface = '';
  if (isBladeTheme(tenant) && provider.memberSlug) {
    var prefix = opts.home ? 'blade.homeTeamCard.' : 'blade.teamCard.';
    cardSurface = bladeBkCardSurfaceAttrs(tenant, prefix + String(provider.memberSlug));
  } else if (isStudio12Theme(tenant) && provider.memberSlug) {
    var s12TeamPrefix = opts.home ? 'studio12.homeTeamCard.' : 'studio12.teamCard.';
    cardSurface = studio12BkCardSurfaceAttrs(tenant, s12TeamPrefix + String(provider.memberSlug));
  }
  var bookable = provider.isBookable !== false && provider.memberSlug;
  if (bookable) {
    return '<article class="bk-team-roster-card"' + cardSurface + '>' +
      '<a href="' + esc(profileUrl) + '" class="bk-team-roster-card-link">' + bodyInner + '</a></article>';
  }
  return '<article class="bk-team-roster-card bk-team-roster-card--static"' + cardSurface + '>' +
    '<div class="bk-team-roster-card-inner">' + bodyInner + '</div></article>';
}

function teamRosterThemeClass(tenant) {
  if (isBladeTheme(tenant)) return 'bk-team-roster-section--blade';
  if (isStonecutTheme(tenant)) return 'bk-team-roster-section--stonecut';
  if (isLuxeTheme(tenant)) return 'bk-team-roster-section--luxe';
  if (isStudio12Theme(tenant)) return 'bk-team-roster-section--studio12';
  return 'bk-team-roster-section--classic';
}

function teamMemberThemeClass(tenant) {
  return teamRosterThemeClass(tenant).replace('bk-team-roster-section', 'bk-team-member-section');
}

function teamRosterColorSurface(tenant, isHome) {
  if (isBladeTheme(tenant)) return 'card';
  if (isStonecutTheme(tenant)) return isHome ? 'page' : 'about';
  if (isLuxeTheme(tenant)) return isHome ? 'featured' : 'about';
  if (isStudio12Theme(tenant)) return isHome ? 'card' : 'about';
  // Classic home Meet the team: card role + classic.team key (not featured/about).
  if (isClassicTheme(tenant) && !isStudio12Theme(tenant) && isHome) return 'card';
  return isHome ? 'featured' : 'about';
}

function defaultTeamRosterSubtitleForIndustry(industry) {
  var k = String(industry || '').trim().toLowerCase();
  if (k === 'barber') return 'The barbers behind the cut';
  if (k === 'hair') return 'The stylists behind the chair';
  if (k === 'nails') return 'The artists behind the look';
  if (k === 'tattoos') return 'The artists behind the work';
  if (k === 'charters') return 'The captains behind the trip';
  return 'The team behind the work';
}

function teamRosterSectionHtml(tenant, providers, opts) {
  opts = opts || {};
  if (!providers || !providers.length) return '';
  var isHome = opts.mode === 'home';
  var list = providers.filter(function(p) {
    if (isHome) return p.showOnTeamHome !== false;
    return p.showOnTeamPage !== false;
  });
  if (!list.length) return '';
  var limit = isHome ? 3 : list.length;
  if (isHome && list.length > limit) list = list.slice(0, limit);
  var cards = list.map(function(p) { return teamRosterCardHtml(tenant, p, { home: isHome }); }).join('');
  var teamUrl = tenantBaseUrl(tenant) + '/team';
  var viewAll = '';
  var homeEligible = providers.filter(function(p) { return p.showOnTeamHome !== false; });
  if (isHome && homeEligible.length > limit && tenantShowTeamPage(tenant)) {
    viewAll = '<p class="bk-team-roster-view-all"><a href="' + esc(teamUrl) + '">' + wcSpan(tenant, 'wc.generic.teamViewAll', 'View full team') + ' \u2192</a></p>';
  }
  var teamSubFallback = defaultTeamRosterSubtitleForIndustry(tenant && tenant.industry);
  var title = isHome
    ? wcSpan(tenant, 'wc.generic.teamHomeTitle', 'Meet the team')
    : wcSpan(tenant, 'wc.generic.teamPageTitle', 'Meet the team');
  var subtitle = isHome
    ? wcSpan(tenant, 'wc.generic.teamHomeSubtitle', teamSubFallback)
    : wcSpan(tenant, 'wc.generic.teamPageSubtitle', teamSubFallback);
  var sectionId = isHome ? ' id="team"' : '';
  var surface = teamRosterColorSurface(tenant, isHome);
  var sectionClass = 'bk-team-roster-section ' + teamRosterThemeClass(tenant) +
    (isHome ? ' bk-team-roster-section--home' : ' bk-team-roster-section--page');
  var scrollHint = '';
  if (!isHome) {
    scrollHint =
      '<div class="bk-team-roster-scroll-hint">' +
      '<button type="button" class="bk-team-roster-scroll-btn" aria-label="Scroll down" ' +
      'onclick="window.scrollBy({top:Math.min(window.innerHeight*0.85,document.body.scrollHeight),behavior:\'smooth\'})">' +
      '<span aria-hidden="true">\u2193</span></button></div>';
  }
  var eyebrowFirst = isStonecutTheme(tenant) || isStudio12Theme(tenant) || isLuxeTheme(tenant) || isClassicTheme(tenant);
  var headHtml = eyebrowFirst
    ? '<div class="bk-team-roster-head">' +
      '<p class="bk-team-roster-subtitle">' + subtitle + '</p>' +
      '<h2 class="bk-team-roster-title">' + title + '</h2>' +
      '</div>'
    : '<div class="bk-team-roster-head">' +
      '<h2 class="bk-team-roster-title">' + title + '</h2>' +
      '<p class="bk-team-roster-subtitle">' + subtitle + '</p>' +
      '</div>';
  var teamKeyAttr = '';
  var nestedPaint = true;
  if (isBladeTheme(tenant)) {
    if (isHome) {
      teamKeyAttr = bladeBkSurfaceKeyAttr(tenant, 'blade.team');
    } else {
      // Page canvas is keyed on `.bk-team-page-band`; avoid a nested unkeyed role stamp.
      nestedPaint = false;
    }
  } else if (isClassicTheme(tenant) && !isStudio12Theme(tenant) && isHome) {
    teamKeyAttr = classicBkSurfaceKeyAttr(tenant, 'classic.team');
  } else if (isLuxeTheme(tenant)) {
    if (isHome) {
      teamKeyAttr = luxeBkSurfaceKeyAttr(tenant, 'luxe.team');
    } else {
      nestedPaint = false;
    }
  } else if (isStonecutTheme(tenant)) {
    if (isHome) {
      teamKeyAttr = stonecutBkSurfaceKeyAttr(tenant, 'stonecut.team');
    } else {
      nestedPaint = false;
    }
  } else if (isStudio12Theme(tenant)) {
    if (isHome) {
      teamKeyAttr = studio12BkSurfaceKeyAttr(tenant, 'studio12.team');
    } else {
      nestedPaint = false;
    }
  }
  var sectionOpen = nestedPaint
    ? ('<section' + sectionId + ' class="' + sectionClass + '" data-bk-color-surface="' + surface + '"' + teamKeyAttr + ' data-bk-band-tappable>')
    : ('<section' + sectionId + ' class="' + sectionClass + '">');
  return sectionOpen +
    bkColorBandInnerWrap(
      headHtml +
      '<div class="bk-team-roster-grid">' + cards + '</div>' +
      viewAll +
      scrollHint
    ) +
  '</section>';
}

function teamHomeSectionHtml(tenant) {
  if (!tenantShowTeamPage(tenant) || !tenantShowMeetTheTeamOnHome(tenant)) return '';
  var providers = tenant._teamProviders;
  if (!providers || !providers.length) return '';
  return teamRosterSectionHtml(tenant, providers, { mode: 'home' });
}

function ensureTeamProvidersLoaded(tenant, callback) {
  var need = isTeamPlan(tenant) && (
    tenantShowMeetTheTeamOnHome(tenant) ||
    tenantShowTeamPage(tenant) ||
    tenantShowGalleryPage(tenant)
  );
  if (!need) {
    tenant._teamProviders = tenant._teamProviders || [];
    callback();
    return;
  }
  if (tenant._teamProviders) {
    callback();
    return;
  }
  loadTeamRoster(tenant.slug).then(function(members) {
    tenant._teamProviders = members || [];
    callback();
  }).catch(function() {
    tenant._teamProviders = [];
    callback();
  });
}

function teamPage(tenant, providers) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var list = providers || [];
  var teamSurface = teamRosterColorSurface(tenant, false);
  var content = teamRosterSectionHtml(tenant, list, { mode: 'page' })
    || '<p class="bk-team-roster-empty">No team members visible yet. Turn on visibility in Design \u2192 Team.</p>';
  if (isStudio12Theme(tenant)) {
    return '<div class="studio12-page studio12-sub">' + studio12NavHtml(tenant) +
      '<div class="bk-team-page-band" data-bk-color-surface="' + teamSurface + '"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.teamPage') +
      ' data-bk-band-tappable>' +
      bkColorBandInnerWrap(content) + '</div>' +
      studio12SiteFooterHtml(tenant) + studio12SidebarHtml(tenant) + '</div>';
  }
  var nav = isBladeTheme(tenant)
    ? bladeNavHtml(tenant, base + '/home')
    : (isLuxeTheme(tenant) ? luxeChromeNavHtml(tenant, 'light') : (isStonecutTheme(tenant) ? stonecutNavHtml(tenant) : tattooNavHtml(tenant)));
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>';
  var wrapClass = 'bk-team-page' +
    (isBladeTheme(tenant) ? ' blade-page blade-page--sub' : '') +
    (isLuxeTheme(tenant) ? ' luxe-page luxe-page--sub' : '') +
    (isClassicTheme(tenant) ? ' classic-home' : '') +
    (isStonecutTheme(tenant) ? ' bk-team-page--stonecut stonecut-page stonecut-page--sub' : '');
  var teamSiteFooter = '';
  if (isBladeTheme(tenant)) teamSiteFooter = bladeSiteFooterHtml(tenant);
  else if (isLuxeTheme(tenant)) teamSiteFooter = luxeContactSectionHtml(tenant);
  else if (isStonecutTheme(tenant)) teamSiteFooter = stonecutSiteFooterHtml(tenant);
  else if (isClassicTheme(tenant)) teamSiteFooter = classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio'));
  var teamPageStyle = tenantPageStyle(tenant, teamSurface);
  return '<div class="' + wrapClass + '">' + nav +
    '<div class="bk-team-page-band" data-bk-color-surface="' + teamSurface + '"' +
    bladeBkSurfaceKeyAttr(tenant, 'blade.teamPage') +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.teamPage') +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.teamPage') +
    ' data-bk-band-tappable style="' + teamPageStyle + '">' +
    bkColorBandInnerWrap(content) + '</div>' +
    teamSiteFooter + galleryLightboxShellHtml() + sidebar + '</div>';
}

function parseBookMemberQuery() {
  try {
    var params = new URLSearchParams(location.search || '');
    var raw = (params.get('member') || params.get('memberSlug') || '').toString().trim().toLowerCase();
    return raw || null;
  } catch (e) {
    return null;
  }
}

function teamMemberPickerSubtitle(provider) {
  var title = (provider.jobTitle || '').toString().trim();
  if (title) return title;
  if (provider.isOwner) return 'Studio owner';
  return '';
}

function teamMemberPickerCardInner(provider) {
  var thumb = provider.profilePhotoUrl || (providerGalleryUrls(provider)[0] || '');
  var img = thumb
    ? '<img src="' + esc(thumb) + '" alt="">'
    : '<div class="bk-team-initial">' + esc((provider.displayName || 'P').charAt(0)) + '</div>';
  var subtitle = teamMemberPickerSubtitle(provider);
  return img +
    '<strong>' + esc(provider.displayName || '') + '</strong>' +
    (subtitle ? '<span>' + esc(subtitle) + '</span>' : '');
}

function teamMemberBookPickerPageHtml(tenant, providers) {
  var cards = providers.map(function(p) {
    var slug = p.memberSlug || '';
    var pickerSurface = slug ? bladeBkCardSurfaceAttrs(tenant, 'blade.pickerCard.' + slug) : '';
    return '<button type="button" class="bk-team-card bk-team-picker-card" data-member-slug="' + esc(slug) + '"' +
      pickerSurface + '>' +
      teamMemberPickerCardInner(p) + '</button>';
  }).join('');
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var nav = isStudio12Theme(tenant)
    ? studio12NavHtml(tenant)
    : (isBladeTheme(tenant)
      ? bladeNavHtml(tenant, base + '/home')
      : (isLuxeTheme(tenant)
        ? luxeChromeNavHtml(tenant, 'light')
        : (isStonecutTheme(tenant) ? stonecutNavHtml(tenant) : tattooNavHtml(tenant))));
  var sidebar = isStudio12Theme(tenant)
    ? studio12SidebarHtml(tenant)
    : ('<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>');
  var bookPageStyle = (isStudio12Theme(tenant) || isBladeTheme(tenant) || isLuxeTheme(tenant) || isStonecutTheme(tenant) || isPortfolioIndustry(tenant.industry))
    ? tenantPageStyle(tenant, 'page')
    : tattooSiteThemeInlineStyle(tenant);
  var wrapClass = isStonecutTheme(tenant)
    ? 'stonecut-page'
    : ('tattoo-page' + (isStudio12Theme(tenant) ? ' studio12-page studio12-sub' : '') + (isBladeTheme(tenant) ? ' blade-page blade-page--sub' : '') + (isLuxeTheme(tenant) ? ' luxe-page luxe-page--sub' : '') + (isClassicTheme(tenant) && !isStudio12Theme(tenant) ? ' classic-home' : ''));
  var bookSiteFooter = '';
  if (isStudio12Theme(tenant)) bookSiteFooter = studio12SiteFooterHtml(tenant);
  else if (isStonecutTheme(tenant)) bookSiteFooter = stonecutSiteFooterHtml(tenant);
  else if (isBladeTheme(tenant)) bookSiteFooter = bladeSiteFooterHtml(tenant);
  else if (isLuxeTheme(tenant)) bookSiteFooter = luxeContactSectionHtml(tenant);
  else if (isClassicTheme(tenant)) bookSiteFooter = classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio'));
  if (!bookSiteFooter) bookSiteFooter = minimalBookLegalFooterHtml(tenant);
  if (isStonecutTheme(tenant)) {
    headerHtml =
      '<div class="booking-page-header">' +
        '<h1 class="booking-page-title">Who would you like to book with?</h1>' +
      '</div>';
  } else if (!isLuxeTheme(tenant) && !isBladeTheme(tenant) && !isClassicTheme(tenant)) {
    headerHtml =
      '<div class="booking-page-header">' +
        (usesThemedChrome(tenant) ? tattooHeadlineLogoHtml(tenant) : '') +
        '<h1 class="booking-page-title">Who would you like to book with?</h1>' +
        '<p class="booking-page-subtitle">Choose a team member, or pick first available.</p>' +
      '</div>';
  }
  var pickerInner =
    headerHtml +
    '<button type="button" class="bk-team-picker-first" data-member-pick-first>' +
      '<strong>First available</strong>' +
      '<span>We\u2019ll match you with the ' + esc(bookingProviderRoleLabel(tenant.industry).toLowerCase()) + ' who can take you soonest.</span>' +
    '</button>' +
    '<section class="bk-team-section bk-team-picker-section" data-bk-color-surface="featured"' +
      bladeBkSurfaceKeyAttr(tenant, 'blade.pickerSection') +
      luxeBkSurfaceKeyAttr(tenant, 'luxe.pickerSection') + '>' +
      (isLuxeTheme(tenant) || isBladeTheme(tenant) || isClassicTheme(tenant) || isStonecutTheme(tenant)
        ? '<h2 style="text-align:center;margin-bottom:28px">Or choose someone</h2>'
        : '<p class="booking-page-subtitle" style="text-align:center;margin-bottom:20px">Or choose someone</p>') +
      '<div class="bk-team-grid">' + cards + '</div>' +
    '</section>';
  return '' +
    bookingPageWrapOpenTag(tenant, wrapClass) +
      nav +
      bookingPageBandOpenTag(tenant, bookPageStyle) +
      bkColorBandInnerWrap('<div class="booking-shell">' +
        bookingCardOpenTag(tenant) +
        bkColorBandInnerWrap(pickerInner) +
        '</div>' +
      '</div>') +
      '</div>' +
      bookSiteFooter +
      sidebar +
    '</div>';
}

function bindTeamMemberBookPicker(tenant, providers, onContinue) {
  var root = document.getElementById('root');
  if (!root) return;
  var bySlug = {};
  for (var i = 0; i < providers.length; i++) {
    bySlug[String(providers[i].memberSlug || '').toLowerCase()] = providers[i];
  }
  var pickButtons = root.querySelectorAll('[data-member-slug]');
  for (var bi = 0; bi < pickButtons.length; bi++) {
    (function(btn) {
      btn.addEventListener('click', function() {
        var slug = String(btn.getAttribute('data-member-slug') || '').toLowerCase();
        tenant._activeProvider = bySlug[slug] || null;
        tenant._assignmentPreference = null;
        tenant._memberPickerResolved = true;
        onContinue();
      });
    })(pickButtons[bi]);
  }
  var firstBtn = root.querySelector('[data-member-pick-first]');
  if (firstBtn) {
    firstBtn.addEventListener('click', function() {
      tenant._activeProvider = null;
      tenant._assignmentPreference = 'first_available';
      tenant._memberPickerResolved = true;
      onContinue();
    });
  }
}

function mountTeamBookChrome(tenant) {
  if (usesThemedChrome(tenant) || isStudio12Theme(tenant)) bindTattooSidebar();
  if (isStudio12Theme(tenant)) bindStudio12Page();
  if (isBladeTheme(tenant)) bindBladeChrome();
  if (isStonecutTheme(tenant)) bindStonecutNavChrome();
  if (tenantShouldBindShopCart(tenant)) bindShopPage(tenant);
  applyBranding(tenant);
  applySidebarIconColor(tenant, true, false);
}

function resolveTeamBookProviders(tenant, renderTenantSite) {
  return loadPublicProviders(tenant.slug).then(function(providers) {
    tenant._bookProviders = providers || [];
    tenant._assignmentPreference = null;
    tenant._activeProvider = null;
    var qSlug = parseBookMemberQuery();
    if (qSlug) {
      for (var qi = 0; qi < tenant._bookProviders.length; qi++) {
        if (String(tenant._bookProviders[qi].memberSlug || '').toLowerCase() === qSlug) {
          tenant._activeProvider = tenant._bookProviders[qi];
          break;
        }
      }
    } else if (tenant._bookProviders.length === 1) {
      tenant._activeProvider = tenant._bookProviders[0];
    }
    tenant._memberPickerResolved = true;
    renderTenantSite();
  });
}

function bookingProviderRoleLabel(industry) {
  var k = String(industry || '').trim().toLowerCase();
  var map = {
    tattoos: 'Artist',
    hair: 'Stylist',
    barber: 'Barber',
    nails: 'Technician',
    charters: 'Captain',
    custom: 'Team member'
  };
  return map[k] || map.custom;
}

function bookingProviderRolePlural(industry) {
  var k = String(industry || '').trim().toLowerCase();
  var map = {
    tattoos: 'artists',
    hair: 'stylists',
    barber: 'barbers',
    nails: 'technicians',
    charters: 'captains',
    custom: 'team members'
  };
  return map[k] || map.custom;
}

function teamMemberProfileContentHtml(tenant, provider) {
  var bookUrl = memberBookUrl(tenant, provider.memberSlug);
  var slug = String(provider.memberSlug || '').trim().toLowerCase();
  function tmPhotoKey() {
    return slug ? ('tm:' + slug + ':photo') : '';
  }
  /** Website copy keys — never write identity fields. */
  function tmWcKey(field) {
    return slug ? ('wc.tm.' + slug + '.' + field) : '';
  }
  function tmWcSpan(field, text, multiline) {
    var key = tmWcKey(field);
    var raw = text == null ? '' : String(text);
    if (!key) {
      return multiline ? esc(raw).replace(/\n/g, '<br>') : esc(raw);
    }
    var emptyAttr = raw ? '' : ' class="bk-copy-empty" data-bk-empty-slot="1"';
    var inner = multiline ? esc(raw).replace(/\n/g, '<br>') : esc(raw);
    return '<span data-edit-key="' + esc(key) + '"' + emptyAttr + '>' + inner + '</span>';
  }
  var siteName = teamMemberSiteName(tenant, provider);
  var siteRole = teamMemberSiteRole(tenant, provider);
  var siteBio = teamMemberSiteBio(tenant, provider);
  var thumb = provider.profilePhotoUrl || '';
  var photoKey = tmPhotoKey();
  var photoKeyAttr = photoKey ? (' data-edit-key="' + esc(photoKey) + '"') : '';
  var photoInner = thumb
    ? '<img' + photoKeyAttr + ' src="' + esc(thumb) + '" alt="">'
    : '<span class="bk-team-member-initials"' + photoKeyAttr + '>' + esc(teamRosterInitials(siteName || provider.displayName)) + '</span>';
  var bioHtml = '<p class="bk-team-member-bio">' + tmWcSpan('bio', siteBio, true) + '</p>';
  var firstName = String(siteName || provider.displayName || 'them').split(' ')[0].toUpperCase();
  var gUrls = providerGalleryUrls(provider);
  var workGrid = '';
  if (gUrls.length) {
    workGrid = '<div class="bk-team-member-grid">' + gUrls.map(function(u) {
      return '<button type="button" class="gallery-lightbox-trigger bk-team-member-grid-item" data-gallery-full="' + esc(u) + '">' +
        '<img src="' + esc(u) + '" alt="" loading="lazy">' +
      '</button>';
    }).join('') + '</div>';
  } else {
    workGrid = '<p class="bk-team-member-work-empty">Portfolio coming soon.</p>';
  }
  var workFirst = String(siteName || provider.displayName || bookingProviderRoleLabel(tenant.industry)).split(' ')[0].toUpperCase();
  var bookFallback = 'BOOK WITH ' + firstName + ' \u2192';
  var bookLabel = slug
    ? webCopyOverrideText(tenant, 'wc.tm.' + slug + '.bookLabel', bookFallback)
    : bookFallback;
  var workFallback = workFirst + '\'S WORK';
  var workTitle = slug
    ? webCopyOverrideText(tenant, 'wc.tm.' + slug + '.workTitle', workFallback)
    : workFallback;
  var scrollHint = gUrls.length > 3
    ? '<div class="bk-team-member-scroll-hint">' +
      '<button type="button" class="bk-team-roster-scroll-btn" aria-label="Scroll down" ' +
      'onclick="window.scrollBy({top:Math.min(window.innerHeight*0.85,document.body.scrollHeight),behavior:\'smooth\'})">' +
      '<span aria-hidden="true">\u2193</span></button></div>'
    : '';
  return '<section class="bk-team-member-section ' + teamMemberThemeClass(tenant) + '">' +
    '<div class="bk-team-member-hero">' +
      '<div class="bk-team-member-photo-col">' +
        '<div class="bk-team-member-photo">' + photoInner + '</div>' +
        '<span class="bk-team-member-badge">' + tmWcSpan('role', siteRole, false) + '</span>' +
      '</div>' +
      '<div class="bk-team-member-copy">' +
        '<h1 class="bk-team-member-name">' + tmWcSpan('name', siteName, false) + '</h1>' +
        '<p class="bk-team-member-role">' + tmWcSpan('role', siteRole, false) + '</p>' +
        bioHtml +
        '<a class="bk-team-member-book" href="' + esc(bookUrl) + '">' +
          tmWcSpan('bookLabel', bookLabel, false) +
        '</a>' +
      '</div>' +
    '</div>' +
    '<div class="bk-team-member-work">' +
      '<h2 class="bk-team-member-work-title">' + tmWcSpan('workTitle', workTitle, false) + '</h2>' +
      workGrid +
      scrollHint +
    '</div>' +
  '</section>';
}

function teamMemberProfilePageHtml(tenant, provider) {
  var content = teamMemberProfileContentHtml(tenant, provider);
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  if (isStudio12Theme(tenant)) {
    return '<div class="studio12-page studio12-sub bk-team-member-page">' + studio12NavHtml(tenant) +
      '<div class="bk-team-page-band" data-bk-color-surface="' + teamRosterColorSurface(tenant, false) + '"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.memberPage') +
      ' data-bk-band-tappable>' +
      bkColorBandInnerWrap(content) + '</div>' +
      studio12SiteFooterHtml(tenant) + studio12SidebarHtml(tenant) + galleryLightboxShellHtml() + '</div>';
  }
  var nav = isBladeTheme(tenant)
    ? bladeNavHtml(tenant, base + '/home')
    : (isLuxeTheme(tenant) ? luxeChromeNavHtml(tenant, 'light') : (isStonecutTheme(tenant) ? stonecutNavHtml(tenant) : tattooNavHtml(tenant)));
  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>';
  var wrapClass = 'bk-team-member-page bk-team-page' +
    (isBladeTheme(tenant) ? ' blade-page blade-page--sub' : '') +
    (isLuxeTheme(tenant) ? ' luxe-page luxe-page--sub' : '') +
    (isClassicTheme(tenant) ? ' classic-home' : '') +
    (isStonecutTheme(tenant) ? ' bk-team-page--stonecut stonecut-page stonecut-page--sub' : '');
  var teamSiteFooter = '';
  if (isBladeTheme(tenant)) teamSiteFooter = bladeSiteFooterHtml(tenant);
  else if (isLuxeTheme(tenant)) teamSiteFooter = luxeContactSectionHtml(tenant);
  else if (isStonecutTheme(tenant)) teamSiteFooter = stonecutSiteFooterHtml(tenant);
  else if (isClassicTheme(tenant)) teamSiteFooter = classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio'));
  var teamSurface = teamRosterColorSurface(tenant, false);
  var teamPageStyle = tenantPageStyle(tenant, teamSurface);
  return '<div class="' + wrapClass + '">' + nav +
    '<div class="bk-team-page-band" data-bk-color-surface="' + teamSurface + '"' +
    bladeBkSurfaceKeyAttr(tenant, 'blade.memberPage') +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.memberPage') +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.memberPage') +
    ' data-bk-band-tappable style="' + teamPageStyle + '">' +
    bkColorBandInnerWrap(content) + '</div>' +
    teamSiteFooter + galleryLightboxShellHtml() + sidebar + '</div>';
}

function bindTeamSubpageChrome(tenant) {
  bindGalleryLightbox(document.getElementById('root'));
  if (isStudio12Theme(tenant)) {
    bindStudio12Page();
    bindTattooSidebar();
  } else {
    bindTattooSidebar();
  }
  applyTenantColorVars(tenant);
  applyBodyPageColors(tenant, 'page');
  applyTenantTypography(tenant);
  if (isBladeTheme(tenant)) bindBladeChrome();
  if (isStonecutTheme(tenant)) bindStonecutNavChrome();
  applySidebarIconColor(tenant, false, true);
  if (tenantShouldBindShopCart(tenant)) bindShopPage(tenant);
}

function mountTeamProvidersSection(tenant) {
  /* Legacy no-op: home team strip is embedded via teamHomeSectionHtml() before footers. */
  return Promise.resolve();
}

function tenantShowTeamPage(tenant) {
  return isTeamPlan(tenant) && tenant.showTeamPage !== false;
}

function tenantShowMeetTheTeamOnHome(tenant) {
  return isTeamPlan(tenant) && tenant.showMeetTheTeamOnHome !== false;
}

function memberBookPathRedirectTarget(p) {
  if (!p.memberSlug || !p.isBookPath) return null;
  var q = '?member=' + encodeURIComponent(p.memberSlug);
  if (p.isSubdomainRoute) return '/book' + q;
  if (!p.tenantSlug) return null;
  return '/' + encodeURIComponent(p.tenantSlug) + '/book' + q;
}

function legacyMemberPathRedirectTarget(p) {
  if (!p.legacyMemberPath || !p.memberSlug) return null;
  if (p.isBookPath) return memberBookPathRedirectTarget(p);
  var suffix = '/team/' + encodeURIComponent(p.memberSlug);
  if (p.isGalleryPath) suffix += '/gallery';
  if (p.serviceSlug) suffix += '/' + encodeURIComponent(p.serviceSlug);
  if (p.isSubdomainRoute) return suffix;
  if (!p.tenantSlug) return null;
  return '/' + encodeURIComponent(p.tenantSlug) + suffix;
}
