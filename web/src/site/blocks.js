/* Sections owners add from the web editor: text box, FAQ, policies, hours and map.
   Saved in tenant.webBlocks as { 'blk-xxxx': { type, page, align, count } } and placed in the
   page order like any template section. Their words live in webCopyOverrides under
   wc.block.{id}.*, so click-to-edit saves them the same way as the rest of the site's text. */

var BLOCK_TYPES = {
  text: { label: 'Text box' },
  faq: { label: 'FAQ' },
  policies: { label: 'Policies' },
  hours: { label: 'Hours and map' }
};

var BLOCK_DEFAULT_ITEMS = {
  faq: [
    ['How do I book?', 'Pick a service and a time on the Book page. You’ll get a confirmation right away.'],
    ['Do you take walk-ins?', 'When there’s an opening, yes. Booking ahead is the best way to get the time you want.'],
    ['How do I pay?', 'Pay online when you book or in person at your appointment.']
  ],
  policies: [
    ['Deposits', 'Some services need a deposit to hold your time. It goes toward your total.'],
    ['Cancellations', 'Please give at least 24 hours’ notice if you need to cancel or reschedule.'],
    ['Late arrivals', 'If you’re more than 15 minutes late, we may need to shorten or move your appointment.']
  ]
};

var BLOCK_DEFAULT_TITLES = {
  text: 'A few words',
  faq: 'Questions',
  policies: 'Policies',
  hours: 'Hours and location'
};

var BLOCK_MAX_ITEMS = 12;

function blockKey(id, field) {
  return 'wc.block.' + id + '.' + field;
}

function blockItemCount(block) {
  var n = parseInt(block && block.count, 10);
  if (isNaN(n)) n = 3;
  return Math.max(1, Math.min(n, BLOCK_MAX_ITEMS));
}

function blockTitleHtml(tenant, id, type) {
  return '<h2 class="bk-block-title">' + wcSpan(tenant, blockKey(id, 'title'), BLOCK_DEFAULT_TITLES[type] || '') + '</h2>';
}

function textBlockHtml(tenant, id) {
  return blockTitleHtml(tenant, id, 'text') +
    '<p class="bk-block-body">' +
    wcSpanMultiline(tenant, blockKey(id, 'body'), 'Tell visitors what makes you different, share news, or add anything else you’d like them to know.') +
    '</p>';
}

/** FAQ and policies: a heading plus question/answer pairs. Pairs cleared in the editor are left off the site. */
function listBlockHtml(tenant, id, block, type) {
  var defaults = BLOCK_DEFAULT_ITEMS[type] || [];
  var editing = isWebDesignPreview();
  var rows = '';
  for (var i = 1; i <= blockItemCount(block); i++) {
    var d = defaults[i - 1] || [type === 'faq' ? 'A question' : 'A policy', 'Write the details here.'];
    var qKey = blockKey(id, 'q' + i);
    var aKey = blockKey(id, 'a' + i);
    var q = webCopyOverrideText(tenant, qKey, d[0]);
    var a = webCopyOverrideText(tenant, aKey, d[1]);
    if (!editing && !q && !a) continue;
    if (type === 'faq') {
      rows += '<details class="bk-block-faq-item"' + (editing ? ' open' : '') + '>' +
        '<summary class="bk-block-q">' + wcSpan(tenant, qKey, d[0]) + '</summary>' +
        '<p class="bk-block-a">' + wcSpanMultiline(tenant, aKey, d[1]) + '</p></details>';
    } else {
      rows += '<div class="bk-block-policy">' +
        '<h3 class="bk-block-q">' + wcSpan(tenant, qKey, d[0]) + '</h3>' +
        '<p class="bk-block-a">' + wcSpanMultiline(tenant, aKey, d[1]) + '</p></div>';
    }
  }
  if (!rows && !editing) return '';
  return blockTitleHtml(tenant, id, type) + '<div class="bk-block-list">' + rows + '</div>';
}

/** Hours from the business schedule and a map of the business address. */
function hoursBlockHtml(tenant, id) {
  var editing = isWebDesignPreview();
  var hours = '';
  var rows = tenantShowBusinessHours(tenant) ? businessHoursWeeklyGroupedRows(tenant) : null;
  if (rows && rows.length) {
    hours = '<div class="bk-block-hours">' + rows.map(function (row) {
      return '<div class="bk-block-hours-row"><span>' + esc(row.label) + '</span>' +
        '<span' + (row.closed ? ' class="is-closed"' : '') + '>' + esc(row.time) + '</span></div>';
    }).join('') + '</div>';
  } else if (tenantShowBusinessHours(tenant) && tenantBusinessHoursTrimmed(tenant)) {
    hours = '<p class="bk-block-body">' + esc(tenantBusinessHoursTrimmed(tenant)).replace(/\n/g, '<br>') + '</p>';
  }
  var address = tenantStreetAddressText(tenant);
  var place = address ? '<p class="bk-block-address"><a href="' + esc(googleMapsSearchUrl(address)) + '" target="_blank" rel="noopener noreferrer">' +
    esc(address).replace(/\n/g, '<br>') + '</a></p>' : '';
  var map = address ? '<div class="bk-block-map"><iframe src="' + esc(googleMapsEmbedUrl(address)) +
    '" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Map"></iframe></div>' : '';
  if (!hours && !address) {
    if (!editing) return '';
    hours = '<p class="bk-block-body bk-block-hint">Add your business hours and address in Settings, and they’ll show here.</p>';
  }
  return blockTitleHtml(tenant, id, 'hours') +
    '<div class="bk-block-hours-wrap"><div>' + hours + place + '</div>' + map + '</div>';
}

function blockInnerHtml(tenant, id, block) {
  if (block.type === 'text') return textBlockHtml(tenant, id);
  if (block.type === 'faq' || block.type === 'policies') return listBlockHtml(tenant, id, block, block.type);
  if (block.type === 'hours') return hoursBlockHtml(tenant, id);
  return '';
}

function blockSectionHtml(tenant, id, block) {
  var inner = blockInnerHtml(tenant, id, block);
  if (!inner) return '';
  var align = block.align === 'center' ? ' bk-block--center' : '';
  return '<section class="bk-block bk-block--' + esc(block.type) + align + '" data-bk-block="' + esc(id) +
    '" data-bk-block-type="' + esc(block.type) + '"><div class="bk-block-inner">' + inner + '</div></section>';
}

/** Added sections for one page, as page-section entries ({ id, label, html }). */
function pageBlockSections(tenant, pageId) {
  var all = tenant && tenant.webBlocks;
  if (!all || typeof all !== 'object') return [];
  return Object.keys(all).filter(function (id) {
    var b = all[id];
    return /^blk-[a-z0-9]{1,24}$/.test(id) && b && BLOCK_TYPES[b.type] && (b.page || 'home') === pageId;
  }).map(function (id) {
    var b = all[id];
    return { id: id, label: BLOCK_TYPES[b.type].label, html: blockSectionHtml(tenant, id, b) };
  });
}

/**
 * Web editor: re-renders added sections from unsaved changes. Replaces, adds, or removes each
 * section in place, then the editor re-applies the page order. Returns true when it ran.
 */
function previewPageBlocks(payload) {
  var base = window.__bkBlocksTenant;
  if (!base || !payload) return false;
  var tenant = Object.assign({}, base, {
    webBlocks: payload.webBlocks || {},
    webCopyOverrides: payload.webCopyOverrides || base.webCopyOverrides || {}
  });
  window.__bkBlocksTenant = tenant;
  var pageId = payload.page || 'home';
  var existing = [].slice.call(document.querySelectorAll('[data-bk-section^="blk-"]'));
  var wanted = {};
  pageBlockSections(tenant, pageId).forEach(function (s) { wanted[s.id] = s; });
  existing.forEach(function (el) {
    if (!wanted[el.getAttribute('data-bk-section')]) el.parentNode.removeChild(el);
  });
  var sections = [].slice.call(document.querySelectorAll('[data-bk-section]'));
  if (!sections.length) return false;
  var last = sections[sections.length - 1];
  Object.keys(wanted).forEach(function (id) {
    var s = wanted[id];
    var holder = document.createElement('div');
    holder.innerHTML = s.html ? stampPageSection(s.html, s, false) : '';
    var fresh = holder.firstElementChild;
    var old = document.querySelector('[data-bk-section="' + id + '"]');
    if (old && fresh) {
      if (old.hasAttribute('data-bk-section-hidden')) fresh.setAttribute('data-bk-section-hidden', '1');
      if (old.hasAttribute('data-bk-design-selected')) fresh.setAttribute('data-bk-design-selected', '1');
      old.parentNode.replaceChild(fresh, old);
    } else if (old) {
      old.parentNode.removeChild(old);
    } else if (fresh) {
      last.parentNode.insertBefore(fresh, last.nextSibling);
      last = fresh;
    }
  });
  return true;
}
