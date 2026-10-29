/* Page sections: a template hands over its sections as a named list; the saved page settings
   (tenant.webPage) decide their order and which are hidden. With nothing saved, the list renders
   in the template's own order, exactly as written. */

/** The web design editor's preview. Not the iOS in-app preview, which has no hidden-section chrome. */
function isWebDesignPreview() {
  return /(?:^|[?&])bk_design=1(?:&|$)/.test(location.search || '');
}

/** Saved settings for one page: { order: [sectionId], sections: { sectionId: { hidden } } }. */
function pageSectionSettings(tenant, pageId) {
  var page = tenant && tenant.webPage && tenant.webPage[pageId];
  if (!page || typeof page !== 'object') return { order: [], sections: {} };
  return {
    order: Array.isArray(page.order) ? page.order : [],
    sections: page.sections && typeof page.sections === 'object' ? page.sections : {}
  };
}

/** Saved order first; anything the saved order doesn't mention keeps its place after its usual neighbor. */
function orderPageSections(list, savedOrder) {
  var remaining = {};
  list.forEach(function (section) { remaining[section.id] = section; });
  var sorted = [];
  savedOrder.forEach(function (id) {
    if (!remaining[id]) return;
    sorted.push(remaining[id]);
    delete remaining[id];
  });
  list.forEach(function (section, index) {
    if (!remaining[section.id]) return;
    var previousId = index > 0 ? list[index - 1].id : '';
    var at = -1;
    for (var i = 0; i < sorted.length; i++) if (sorted[i].id === previousId) at = i;
    sorted.splice(at + 1, 0, section);
  });
  return sorted;
}

/** Sections that can take a photo beside their content (Photo layout in the web editor). */
var SECTION_PHOTO_IDS = { promo: 1, about: 1, reviews: 1, info: 1, location: 1, philosophy: 1, process: 1, book: 1 };

function sectionPhotoAllowed(id) {
  return !!SECTION_PHOTO_IDS[id] || /^blk-/.test(id);
}

/** Saved photo for a section: { url, side: 'left'|'right' }, or null. */
function sectionPhotoFor(tenant, id) {
  var all = tenant && tenant.webSectionPhotos;
  var p = all && typeof all === 'object' ? all[id] : null;
  if (!p || !p.url || !sectionPhotoAllowed(id)) return null;
  if (!/^https:\/\//.test(String(p.url))) return null;
  return { url: String(p.url), side: p.side === 'right' ? 'right' : 'left' };
}

function sectionPhotoHtml(photo) {
  return '<div class="bk-sec-photo"><img src="' + esc(photo.url) + '" alt="" loading="lazy"></div>';
}

/** Puts the section's own content in a column beside the photo, inside the section's root element. */
function wrapSectionWithPhoto(html, photo) {
  var open = html.indexOf('>');
  var close = html.lastIndexOf('</');
  if (open === -1 || close <= open) return html;
  return html.slice(0, open + 1) +
    '<div class="bk-sec-photo-grid" data-photo-side="' + photo.side + '">' + sectionPhotoHtml(photo) +
    '<div class="bk-sec-photo-body">' + html.slice(open + 1, close) + '</div></div>' +
    html.slice(close);
}

/** Web editor: the same change on a section already on the page (adds, moves, or removes the photo). */
function applySectionPhotoToElement(el, photo) {
  var grid = null;
  for (var i = 0; i < el.children.length; i++) {
    if (el.children[i].classList.contains('bk-sec-photo-grid')) grid = el.children[i];
  }
  if (!photo) {
    if (!grid) return;
    var body = grid.querySelector('.bk-sec-photo-body');
    while (body && body.firstChild) el.insertBefore(body.firstChild, grid);
    el.removeChild(grid);
    return;
  }
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'bk-sec-photo-grid';
    var bodyEl = document.createElement('div');
    bodyEl.className = 'bk-sec-photo-body';
    while (el.firstChild) bodyEl.appendChild(el.firstChild);
    grid.innerHTML = sectionPhotoHtml(photo);
    grid.appendChild(bodyEl);
    el.appendChild(grid);
  } else {
    grid.querySelector('.bk-sec-photo img').src = photo.url;
  }
  grid.setAttribute('data-photo-side', photo.side);
}

/** Editor preview: section photos from unsaved changes. */
function previewSectionPhotos(map) {
  var tenant = { webSectionPhotos: map || {} };
  [].forEach.call(document.querySelectorAll('[data-bk-section]'), function (el) {
    applySectionPhotoToElement(el, sectionPhotoFor(tenant, el.getAttribute('data-bk-section')));
  });
}

/** Labels the section's own root element; no wrapper, so the page structure is unchanged. */
function stampPageSection(html, section, hidden) {
  var attrs = ' data-bk-section="' + esc(section.id) + '" data-bk-section-label="' + esc(section.label || section.id) + '"' +
    (hidden ? ' data-bk-section-hidden="1"' : '');
  return html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9-]*)/, '$1' + attrs);
}

/**
 * Joins a page's movable sections. `list` is [{ id, label, html }] in the template's default order;
 * a section with empty html (nothing to show) is skipped. Hidden sections are left out of the
 * public page, and kept (marked) in the web editor preview so they can be shown again.
 */
function renderPageSections(tenant, pageId, list) {
  var settings = pageSectionSettings(tenant, pageId);
  var editing = isWebDesignPreview();
  // Remembered so the web editor can re-render added sections live (see blocks.js).
  window.__bkBlocksTenant = tenant;
  window.__bkPreviewBlocks = previewPageBlocks;
  window.__bkPreviewSectionPhotos = previewSectionPhotos;
  list = list.concat(pageBlockSections(tenant, pageId));
  return orderPageSections(list, settings.order).map(function (section) {
    if (!section.html) return '';
    var saved = settings.sections[section.id];
    var hidden = !!(saved && saved.hidden === true);
    if (hidden && !editing) return '';
    var photo = sectionPhotoFor(tenant, section.id);
    return stampPageSection(photo ? wrapSectionWithPhoto(section.html, photo) : section.html, section, hidden);
  }).join('');
}
