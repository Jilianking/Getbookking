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
  return orderPageSections(list, settings.order).map(function (section) {
    if (!section.html) return '';
    var saved = settings.sections[section.id];
    var hidden = !!(saved && saved.hidden === true);
    if (hidden && !editing) return '';
    return stampPageSection(section.html, section, hidden);
  }).join('');
}
