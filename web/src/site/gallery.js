/* Gallery pages and the photo lightbox. */

function memberGalleryUrl(tenant, memberSlug) {
  return memberProfileUrl(tenant, memberSlug) + '/gallery';
}

function providerGalleryUrls(provider) {
  if (!provider || !provider.providerGalleryImages) return [];
  return provider.providerGalleryImages.filter(function(u) { return u && String(u).trim(); });
}

function providerGalleryPageHtml(tenant, provider) {
  var profileUrl = memberProfileUrl(tenant, provider.memberSlug);
  var bookUrl = memberBookUrl(tenant, provider.memberSlug);
  var gUrls = providerGalleryUrls(provider);
  var grid = gUrls.length
    ? '<div class="bk-provider-gallery-grid">' + gUrls.map(function(u) {
        return galleryLightboxTriggerHtml(u, { className: 'gallery-grid-link' });
      }).join('') + '</div>'
    : '<p class="gallery-empty-hint">No portfolio images yet.</p>';
  return '<div class="container"><div class="bk-provider-gallery-page card">' +
    '<p class="bk-provider-studio-link"><a href="' + esc(profileUrl) + '">← ' + esc(provider.displayName || 'Team member') + '</a></p>' +
    '<h1>' + esc(provider.displayName || '') + '</h1>' +
    '<p class="bk-provider-gallery-sub">' + esc(provider.jobTitle || 'Portfolio') + '</p>' +
    grid +
    '<p style="margin-top:28px;text-align:center"><a class="bk-provider-book-cta" style="background:' + esc(tenantColors(tenant).accent) + ';color:' + esc(tenantColors(tenant).accentFg) + '" href="' + esc(bookUrl) + '">Book now</a></p>' +
    '</div></div>';
}

function tenantShowGalleryPage(tenant) {
  return tenant.showGalleryPage !== false;
}

function maxCellsFromGalleryLayout(layoutStr, defaultCols, defaultRows) {
  var layout = String(layoutStr || '3x1').toLowerCase().replace(/\u00d7/g, 'x').split('x');
  var c = parseInt(layout[0], 10);
  var r = parseInt(layout[1], 10);
  if (!c || c < 1) c = defaultCols;
  if (!r || r < 1) r = defaultRows;
  return c * r;
}

/** Home featured strip: new schema uses featuredWorkImages; legacy uses first maxCells of galleryImages. */
function featuredUrlsForHomeStrip(tenant, maxCells) {
  if (Object.prototype.hasOwnProperty.call(tenant, 'featuredWorkImages') && tenant.featuredWorkImages != null) {
    return (tenant.featuredWorkImages || []).slice(0, maxCells);
  }
  var g = tenant.galleryImages || [];
  return g.slice(0, maxCells);
}

/** URL at slot `index` for home featured strip; empty string = empty slot (supports sparse arrays). */
function featuredStripSlotUrl(urls, index) {
  if (!urls || index < 0 || index >= urls.length) return '';
  var u = urls[index];
  return (u != null && String(u).trim() !== '') ? String(u).trim() : '';
}

/** /gallery page items: solo uses tenant.galleryImages; Studio/Shop merges gallery tab + per-artist portfolios. */
function galleryPageItems(tenant) {
  if (isTeamPlan(tenant)) {
    var items = [];
    (tenant.galleryImages || []).forEach(function(u, index) {
      if (u && String(u).trim()) {
        items.push({
          url: String(u).trim(),
          memberSlug: '',
          displayName: '',
          index: index
        });
      }
    });
    (tenant._teamProviders || []).forEach(function(p) {
      var slug = String(p.memberSlug || '').toLowerCase();
      providerGalleryUrls(p).forEach(function(url) {
        items.push({
          url: url,
          memberSlug: slug,
          displayName: p.displayName || ''
        });
      });
    });
    return items;
  }
  return (tenant.galleryImages || []).map(function(u, index) {
    return { url: u, memberSlug: '', displayName: '', index: index };
  });
}

/** /gallery page: always aggregated items (Gallery tab for solo; team portfolios for Studio/Shop). */
function galleryPageImageUrls(tenant) {
  return galleryPageItems(tenant).map(function(it) { return it.url; });
}

function galleryMemberAttr(item) {
  return item && item.memberSlug
    ? ' data-gallery-member="' + esc(item.memberSlug) + '"'
    : '';
}

function galleryItemEditAttr(item, gi) {
  if (item && item.memberSlug) return '';
  var idx = item && item.index != null ? item.index : gi;
  return galleryImageEditKeyAttr(idx);
}

function galleryPageEmptyHint(tenant) {
  return isTeamPlan(tenant)
    ? 'No gallery photos yet. Add studio photos in Design \u2192 Gallery, or artist portfolios in Design \u2192 Team.'
    : 'No gallery images yet. Add them in the app.';
}

function galleryTeamFilterHtml(tenant) {
  if (!isTeamPlan(tenant) || !tenant._teamProviders) return '';
  var bySlug = {};
  galleryPageItems(tenant).forEach(function(it) {
    if (it.memberSlug) bySlug[it.memberSlug] = it.displayName || it.memberSlug;
  });
  var slugs = Object.keys(bySlug);
  if (slugs.length < 2) return '';
  slugs.sort(function(a, b) {
    return String(bySlug[a]).localeCompare(String(bySlug[b]));
  });
  var btns = '<button type="button" class="gallery-team-filter-btn is-active" data-gallery-filter="all" role="tab" aria-selected="true">All</button>';
  slugs.forEach(function(slug) {
    btns += '<button type="button" class="gallery-team-filter-btn" data-gallery-filter="' + esc(slug) + '" role="tab" aria-selected="false">' + esc(bySlug[slug]) + '</button>';
  });
  return '<div class="gallery-team-filter" data-gallery-team-filter role="tablist" aria-label="Filter by artist">' + btns + '</div>';
}

function galleryPageGridHtml(items) {
  var imgsHtml = items.map(function(item, gi) {
    return galleryLightboxTriggerHtml(item.url, {
      className: 'gallery-grid-link',
      editAttr: galleryItemEditAttr(item, gi),
      extraAttrs: galleryMemberAttr(item)
    });
  }).join('');
  return '<div class="gallery-grid">' + imgsHtml + '</div>';
}

function galleryAltLayoutItemsHtml(items, mode) {
  if (mode === 'masonry') {
    return '<div class="gallery-alt gallery-alt--masonry">' + items.map(function(item, gi) {
      return '<div class="gallery-alt-masonry-cell"' + galleryMemberAttr(item) + '>' +
        galleryLightboxTriggerHtml(item.url, {
          className: 'gallery-grid-link',
          editAttr: galleryItemEditAttr(item, gi)
        }) + '</div>';
    }).join('') + '</div>';
  }
  if (mode === 'horizontal_strip') {
    return '<div class="gallery-alt gallery-alt--strip">' + items.map(function(item, gi) {
      return '<div class="gallery-alt-strip-item"' + galleryMemberAttr(item) + '>' +
        galleryLightboxTriggerHtml(item.url, {
          className: 'gallery-grid-link',
          editAttr: galleryItemEditAttr(item, gi)
        }) + '</div>';
    }).join('') + '</div>';
  }
  return '';
}

function galleryPageBodyHtml(tenant, items, layoutMode) {
  if (!items.length) {
    return '<p class="gallery-empty-hint">' + galleryPageEmptyHint(tenant) + '</p>';
  }
  if (layoutMode === 'classic_grid') return galleryPageGridHtml(items);
  return galleryAltLayoutItemsHtml(items, layoutMode);
}

/** Quick edit: tap opens native gallery upload for slot `index`. */
function galleryImageEditKeyAttr(index) {
  return ' data-edit-key="galleryImage:' + index + '" aria-label="Change gallery photo"';
}

/**
 * Normalized `/gallery` layout id. Any template can use any allowed layout.
 * `classic_grid` = portfolio grid or Studio 12 native grid.
 * Legacy `default`, `cinematic`, `featured_thumbnails`, unknown → classic_grid.
 */
function effectiveGalleryLayoutStyle(tenant) {
  var s = String(tenant.galleryLayoutStyle != null ? tenant.galleryLayoutStyle : '')
    .toLowerCase()
    .trim()
    .replace(/-/g, '_');
  if (s === 'masonry') return 'masonry';
  if (s === 'horizontal_strip') return 'horizontal_strip';
  return 'classic_grid';
}

function galleryLightboxTriggerHtml(url, opts) {
  opts = opts || {};
  var className = opts.className || 'gallery-grid-link';
  var editAttr = opts.editAttr || '';
  var extraAttrs = opts.extraAttrs || '';
  var loading = opts.loading === false ? '' : ' loading="lazy"';
  return '<button type="button" class="' + className + ' gallery-lightbox-trigger" data-gallery-full="' + esc(url) + '"' + extraAttrs + '>' +
    '<img' + editAttr + ' src="' + esc(url) + '" alt=""' + loading + '></button>';
}

function galleryLightboxCell(url, linkClass, gi) {
  linkClass = linkClass || '';
  var editAttr = (typeof gi === 'number' && gi >= 0) ? galleryImageEditKeyAttr(gi) : '';
  return galleryLightboxTriggerHtml(url, {
    className: ('gallery-grid-link ' + linkClass).trim(),
    editAttr: editAttr
  });
}

/** HTML for optional layouts (not used when style is `default`). */
function galleryAltLayoutInnerHtml(urls, mode) {
  if (mode === 'masonry') {
    return '<div class="gallery-alt gallery-alt--masonry">' + urls.map(function(u, gi) {
      return '<div class="gallery-alt-masonry-cell">' + galleryLightboxCell(u, '', gi) + '</div>';
    }).join('') + '</div>';
  }
  if (mode === 'horizontal_strip') {
    return '<div class="gallery-alt gallery-alt--strip">' + urls.map(function(u, gi) {
      return '<div class="gallery-alt-strip-item">' + galleryLightboxCell(u, '', gi) + '</div>';
    }).join('') + '</div>';
  }
  return '';
}

function galleryLightboxShellHtml() {
  return '<div id="gallery-lightbox" class="gallery-lightbox" role="dialog" aria-modal="true" aria-label="Image preview">' +
    '<div class="gallery-lightbox-backdrop"></div>' +
    '<button type="button" class="gallery-lightbox-nav gallery-lightbox-prev" aria-label="Previous image">&#8249;</button>' +
    '<button type="button" class="gallery-lightbox-nav gallery-lightbox-next" aria-label="Next image">&#8250;</button>' +
    '<p class="gallery-lightbox-counter" aria-live="polite"></p>' +
    '<div class="gallery-lightbox-inner">' +
    '<button type="button" class="gallery-lightbox-close" aria-label="Close">&times;</button>' +
    '<div class="gallery-lightbox-stage">' +
    '<img class="gallery-lightbox-img" src="" alt="" draggable="false">' +
    '</div></div></div>';
}

function galleryPage(tenant) {
  var base = tenantBaseUrl(tenant);
  var bookUrl = base + '/book';
  var galleryUrl = base + '/gallery';
  var gItems = galleryPageItems(tenant);
  var filterHtml = galleryTeamFilterHtml(tenant);

  if (isStudio12Theme(tenant)) {
    var gLay = effectiveGalleryLayoutStyle(tenant);
    var galleryBody;
    if (!gItems.length) {
      galleryBody = '<div class="s12-gallery-empty-state"><p class="s12-phil-body">' + esc(galleryPageEmptyHint(tenant)) + '</p></div>';
    } else if (gLay === 'classic_grid') {
      var imgs12 = gItems.map(function(item, gi) {
        return '<div class="s12-g-item s12-fade"' + galleryMemberAttr(item) + '>' +
          galleryLightboxTriggerHtml(item.url, {
            className: 's12-gallery-full-link',
            editAttr: galleryItemEditAttr(item, gi)
          }) + '</div>';
      }).join('');
      galleryBody = '<div class="s12-gallery-page-grid" data-gallery-count="' + Math.min(gItems.length, 24) + '">' + imgs12 + '</div>';
    } else {
      galleryBody = galleryAltLayoutItemsHtml(gItems, gLay);
    }
    var s12GalleryInner = '<div class="s12-gallery-head"><h2 class="s12-gallery-title"><a href="' + esc(galleryUrl) + '" class="s12-gallery-title-link">Gallery</a></h2></div>' +
      filterHtml + galleryBody;
    var s12LightClasses = 's12-gallery-light s12-gallery-light--fullpage';
    if (gLay === 'horizontal_strip') {
      s12GalleryInner = '<div class="gallery-page-strip-main s12-gallery-strip-main">' + s12GalleryInner + '</div>';
      s12LightClasses += ' s12-gallery-light--strip-centered';
    }
    return '<div class="studio12-page studio12-sub">' + studio12NavHtml(tenant) +
      '<div class="' + s12LightClasses + ' gallery-page-band" data-bk-color-surface="gallery"' +
      studio12BkSurfaceKeyAttr(tenant, 'studio12.galleryPage') +
      ' data-bk-band-tappable>' +
      bkColorBandInnerWrap(s12GalleryInner) + '</div>' + studio12SiteFooterHtml(tenant) + studio12SidebarHtml(tenant) +
      galleryLightboxShellHtml() + '</div>';
  }

  var nav = isBladeTheme(tenant)
    ? bladeNavHtml(tenant, base + '/home')
    : (isLuxeTheme(tenant) ? luxeChromeNavHtml(tenant, 'light') : tattooNavHtml(tenant));

  var sidebar = '<div class="tattoo-sidebar" id="tattoo-sidebar">' +
    '<div class="tattoo-sidebar-backdrop"></div>' +
    tattooSidebarPanelOpenTag(tenant) +
    tattooSidebarPanelContentHtml(tenant, base, bookUrl) +
    '</div></div>';

  var gLayStd = effectiveGalleryLayoutStyle(tenant);
  var stripPage = gLayStd === 'horizontal_strip';
  var content = galleryPageBodyHtml(tenant, gItems, gLayStd);
  var galleryPageStyle = tenantPageStyle(tenant, 'gallery');

  var galleryWrapClass = 'gallery-page' +
    (isBladeTheme(tenant) ? ' blade-page blade-page--sub' : '') +
    (isLuxeTheme(tenant) ? ' luxe-page luxe-page--sub' : '') +
    (isClassicTheme(tenant) ? ' classic-home' : '') +
    (isStonecutTheme(tenant) ? ' gallery-page--stonecut' : '') +
    (stripPage ? ' gallery-page--horizontal-strip' : '');
  var galleryHeadline = wcSpan(tenant, 'wc.generic.galleryPageTitle', 'Gallery');
  var galleryTitleHtml = '<h1 class="gallery-title' + (stripPage ? ' gallery-title--strip-standard' : '') + '"><a href="' + esc(galleryUrl) + '" class="gallery-title-link">' + galleryHeadline + '</a></h1>';
  var gallerySiteFooter = '';
  if (isBladeTheme(tenant)) gallerySiteFooter = bladeSiteFooterHtml(tenant);
  else if (isLuxeTheme(tenant)) gallerySiteFooter = luxeContactSectionHtml(tenant);
  else if (isStonecutTheme(tenant)) gallerySiteFooter = stonecutSiteFooterHtml(tenant);
  else if (isClassicTheme(tenant)) gallerySiteFooter = classicSiteFooterHtml(tenant, tenantSiteDisplayName(tenant, 'Studio'));
  var galleryHeaderBlock = '<div class="gallery-header">' + tattooHeadlineLogoHtml(tenant) + galleryTitleHtml + filterHtml + '</div>';
  var galleryShellBlock = '<div class="gallery-shell">' + content + '</div>';
  var galleryMainBlock = stripPage
    ? ('<div class="gallery-page-strip-main">' + galleryHeaderBlock + galleryShellBlock + '</div>')
    : (galleryHeaderBlock + galleryShellBlock);
  return '<div class="' + galleryWrapClass + '">' +
    nav +
    '<div class="gallery-page-band" data-bk-color-surface="gallery"' +
    bladeBkSurfaceKeyAttr(tenant, 'blade.galleryPage') +
    classicBkSurfaceKeyAttr(tenant, 'classic.galleryPage') +
    luxeBkSurfaceKeyAttr(tenant, 'luxe.galleryPage') +
    stonecutBkSurfaceKeyAttr(tenant, 'stonecut.galleryPage') +
    ' data-bk-band-tappable style="'+galleryPageStyle+'">' +
    bkColorBandInnerWrap(galleryMainBlock) + '</div>' +
    gallerySiteFooter +
    galleryLightboxShellHtml() +
    sidebar +
    '</div>';
}

function bindGalleryTeamFilter(root) {
  if (!root || !root.querySelector) return;
  var bar = root.querySelector('[data-gallery-team-filter]');
  if (!bar) return;
  bar.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest ? e.target.closest('[data-gallery-filter]') : null;
    if (!btn || !bar.contains(btn)) return;
    var filter = btn.getAttribute('data-gallery-filter') || 'all';
    var buttons = bar.querySelectorAll('[data-gallery-filter]');
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i] === btn;
      buttons[i].classList.toggle('is-active', active);
      buttons[i].setAttribute('aria-selected', active ? 'true' : 'false');
    }
    var cells = root.querySelectorAll('[data-gallery-member]');
    for (var j = 0; j < cells.length; j++) {
      var slug = cells[j].getAttribute('data-gallery-member') || '';
      var show = filter === 'all' || slug === filter;
      cells[j].classList.toggle('gallery-item--hidden', !show);
    }
  });
}

function bindGalleryLightbox(root) {
  if (!root) return;
  var lb = root.querySelector('#gallery-lightbox');
  if (!lb) return;
  var img = lb.querySelector('.gallery-lightbox-img');
  var backdrop = lb.querySelector('.gallery-lightbox-backdrop');
  var closeBtn = lb.querySelector('.gallery-lightbox-close');
  var prevBtn = lb.querySelector('.gallery-lightbox-prev');
  var nextBtn = lb.querySelector('.gallery-lightbox-next');
  var counterEl = lb.querySelector('.gallery-lightbox-counter');
  if (!img) return;
  var urls = [];
  var idx = 0;
  function collectUrls() {
    var triggers = root.querySelectorAll('.gallery-lightbox-trigger');
    var list = [];
    var seen = Object.create(null);
    for (var i = 0; i < triggers.length; i++) {
      var t = triggers[i];
      if (t.closest && t.closest('.gallery-item--hidden')) continue;
      if (t.closest && t.closest('[aria-hidden="true"]')) continue;
      var u = t.getAttribute('data-gallery-full');
      if (u && !seen[u]) {
        seen[u] = true;
        list.push(u);
      }
    }
    return list;
  }
  function updateChrome() {
    var n = urls.length;
    if (counterEl) {
      counterEl.textContent = n > 1 ? (idx + 1) + ' / ' + n : '';
      counterEl.style.display = n > 1 ? '' : 'none';
    }
    var solo = n <= 1;
    if (prevBtn) prevBtn.disabled = solo;
    if (nextBtn) nextBtn.disabled = solo;
  }
  function showIndex(i) {
    if (!urls.length) return;
    idx = (i % urls.length + urls.length) % urls.length;
    img.src = urls[idx];
    img.alt = '';
    updateChrome();
  }
  function goPrev() { showIndex(idx - 1); }
  function goNext() { showIndex(idx + 1); }
  var onKey = function(ev) {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'ArrowLeft') goPrev();
    else if (ev.key === 'ArrowRight') goNext();
  };
  function openFromTrigger(t) {
    var src = t.getAttribute('data-gallery-full');
    if (!src) return;
    urls = collectUrls();
    var j = urls.indexOf(src);
    if (j < 0 || !urls.length) return;
    idx = j;
    img.src = urls[idx];
    img.alt = '';
    lb.classList.add('gallery-lightbox--open');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    updateChrome();
  }
  function close() {
    lb.classList.remove('gallery-lightbox--open');
    img.src = '';
    urls = [];
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (counterEl) counterEl.textContent = '';
  }
  root.addEventListener('click', function(e) {
    // App Quick Edit owns image taps while editing.
    if (document.getElementById('bk-quick-edit-style')) return;
    var t = e.target.closest('.gallery-lightbox-trigger');
    if (!t || !root.contains(t)) return;
    if (t.closest('.gallery-item--hidden')) return;
    if (!t.getAttribute('data-gallery-full')) return;
    e.preventDefault();
    e.stopPropagation();
    openFromTrigger(t);
  });
  if (backdrop) backdrop.addEventListener('click', close);
  if (closeBtn) {
    closeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      close();
    });
  }
  if (prevBtn) {
    prevBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      goPrev();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      goNext();
    });
  }
  var touchStartX = null;
  img.addEventListener('touchstart', function(e) {
    if (e.changedTouches.length !== 1) return;
    touchStartX = e.changedTouches[0].clientX;
  }, { passive: true });
  img.addEventListener('touchend', function(e) {
    if (touchStartX == null || e.changedTouches.length !== 1) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (urls.length <= 1) return;
    if (dx > 56) goPrev();
    else if (dx < -56) goNext();
  }, { passive: true });
}
