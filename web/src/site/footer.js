/* The Get Bookking footer: one shared footer whose blocks a shop switches on or off in the web
   design editor (tenant.webFooter). When it isn't enabled, each template keeps its own footer. */

function footerIconSvg(network) {
  if (network === 'instagram') {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1" fill="currentColor" stroke="none"/></svg>';
  }
  if (network === 'facebook') {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-7.2h2.4l.4-2.9h-2.8V9.1c0-.8.3-1.4 1.5-1.4h1.4V5.1c-.3 0-1.1-.1-2.1-.1-2.1 0-3.5 1.3-3.5 3.6v2.3H8.4v2.9h2.4V21h2.7z"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M16.5 3c.3 2 1.5 3.4 3.5 3.6v2.7c-1.3 0-2.5-.4-3.5-1.1v6.3a5.5 5.5 0 1 1-5.5-5.5c.3 0 .6 0 .9.1v2.8a2.7 2.7 0 1 0 1.9 2.6V3h2.7z"/></svg>';
}

/** Footer settings when the shop has switched the Get Bookking footer on; otherwise null. */
function customFooterSettings(tenant) {
  var f = tenant && tenant.webFooter;
  return f && typeof f === 'object' && f.enabled === true ? f : null;
}

/** Text safe to place inside a double-quoted attribute. */
function footerAttr(value) {
  return esc(value).replace(/"/g, '&quot;');
}

/** A handle or pasted link for one network, as a full https URL ('' when unusable). */
function footerSocialUrl(network, raw) {
  var value = String(raw || '').trim();
  if (!value || /[\s"'<>]/.test(value)) return '';
  if (/^https?:\/\//i.test(value)) return value;
  var handle = value.replace(/^@/, '').replace(/^\/+/, '');
  if (!/^[A-Za-z0-9._-]+$/.test(handle)) return '';
  if (network === 'instagram') return 'https://instagram.com/' + handle;
  if (network === 'facebook') return 'https://facebook.com/' + handle;
  if (network === 'tiktok') return 'https://www.tiktok.com/@' + handle;
  return '';
}

/** An owner-entered link: web, email, or phone only, so a typo can't become a script URL. */
function footerExternalUrl(raw) {
  var value = String(raw || '').trim();
  if (!value || /[\s"'<>]/.test(value)) return '';
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return value;
  if (/^[^:\/]+\.[^:\/]+/.test(value)) return 'https://' + value;
  return '';
}

function footerPageLinks(tenant) {
  var base = tenantBaseUrl(tenant);
  var links = [{ label: 'Home', href: base + '/home' }];
  if (tenantShowGalleryPage(tenant)) links.push({ label: 'Gallery', href: base + '/gallery' });
  if (tenantShowTeamPage(tenant)) links.push({ label: 'Team', href: base + '/team' });
  if (tenantShowShopPage(tenant)) links.push({ label: 'Shop', href: base + '/shop' });
  if (tenantShowAboutPage(tenant)) links.push({ label: 'About', href: base + '/about' });
  if (tenantShowBookPage(tenant)) links.push({ label: 'Book', href: base + '/book' });
  return links;
}

function footerColumnHtml(tenant, titleKey, titleFallback, bodyHtml) {
  if (!bodyHtml) return '';
  return '<div class="bk-footer-col">' +
    '<p class="bk-footer-title">' + wcSpan(tenant, titleKey, titleFallback) + '</p>' + bodyHtml + '</div>';
}

/**
 * The shared footer, or '' when the shop hasn't switched it on (the template then renders its own).
 * `opts.attrs` carries the template's surface attributes so colors and selection keep working;
 * `opts.wrap` matches templates whose footer background is tappable in the app's editor.
 */
function customSiteFooterHtml(tenant, opts) {
  // Remembered so the web editor can re-render the footer live.
  window.__bkFooterTenant = tenant;
  window.__bkPreviewFooter = previewSiteFooter;
  var f = customFooterSettings(tenant);
  if (!f) return '';
  opts = opts || {};

  var brand = '';
  if (f.showName !== false) brand += '<div class="bk-footer-name">' + siteNameSpan(tenant, 'Studio', 'displayName.footer') + '</div>';
  if (f.showSocial !== false) {
    var networks = [
      ['instagram', 'Instagram', footerSocialUrl('instagram', tenant.instagramHandle)],
      ['facebook', 'Facebook', footerSocialUrl('facebook', f.facebook)],
      ['tiktok', 'TikTok', footerSocialUrl('tiktok', f.tiktok)]
    ];
    var icons = networks.filter(function (n) { return n[2]; }).map(function (n) {
      return '<a class="bk-footer-social-link" href="' + footerAttr(n[2]) + '" target="_blank" rel="noopener noreferrer" aria-label="' + n[1] + '">' +
        footerIconSvg(n[0]) + '</a>';
    }).join('');
    if (icons) brand += '<div class="bk-footer-social">' + icons + '</div>';
  }
  if (f.showBook !== false && tenantShowBookPage(tenant)) {
    brand += '<a class="bk-footer-book" data-cta-key="wc.footer.book" href="' + tenantBaseUrl(tenant) + '/book">' +
      wcSpan(tenant, 'wc.footer.bookLabel', 'Book now') + '</a>';
  }

  var nav = '';
  if (f.showNav !== false) {
    nav = '<ul class="bk-footer-list">' + footerPageLinks(tenant).map(function (link) {
      return '<li><a href="' + footerAttr(link.href) + '">' + esc(link.label) + '</a></li>';
    }).join('') + '</ul>';
  }

  var contact = '';
  if (f.showContact !== false) {
    var address = tenantStreetAddressText(tenant) || (tenant.serviceArea && String(tenant.serviceArea).trim()) || '';
    var lines = [];
    if (address) {
      var maps = googleMapsSearchUrl(address);
      lines.push(maps
        ? '<a href="' + footerAttr(maps) + '" target="_blank" rel="noopener noreferrer">' + esc(address) + '</a>'
        : esc(address));
    }
    if (tenant.contactPhone) {
      var tel = telHrefFromPhone(tenant.contactPhone);
      lines.push(tel ? '<a href="' + footerAttr(tel) + '">' + contactPhoneDisplayEscaped(tenant) + '</a>' : contactPhoneDisplayEscaped(tenant));
    }
    if (tenant.contactEmail) {
      lines.push('<a href="mailto:' + footerAttr(tenant.contactEmail) + '">' + esc(tenant.contactEmail) + '</a>');
    }
    if (lines.length) contact = '<ul class="bk-footer-list">' + lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>';
  }

  var hours = '';
  if (f.showHours === true && tenantBusinessHoursTrimmed(tenant)) {
    hours = '<p class="bk-footer-hours">' + esc(tenantBusinessHoursTrimmed(tenant)) + '</p>';
  }

  var more = '';
  var extra = (Array.isArray(f.links) ? f.links : []).map(function (link) {
    var url = footerExternalUrl(link && link.url);
    var label = String((link && link.label) || '').trim();
    if (!url || !label) return '';
    var outside = /^https?:/i.test(url);
    return '<li><a href="' + footerAttr(url) + '"' + (outside ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(label) + '</a></li>';
  }).join('');
  if (extra) more = '<ul class="bk-footer-list">' + extra + '</ul>';

  var inner = '<div class="bk-footer-inner">' +
    (brand ? '<div class="bk-footer-col bk-footer-brand">' + brand + '</div>' : '') +
    footerColumnHtml(tenant, 'wc.footer.navTitle', 'Explore', nav) +
    footerColumnHtml(tenant, 'wc.footer.contactTitle', 'Contact', contact) +
    footerColumnHtml(tenant, 'wc.footer.hoursTitle', 'Hours', hours) +
    footerColumnHtml(tenant, 'wc.footer.moreTitle', 'More', more) +
    '</div>' +
    '<p class="bk-footer-legal">' + footerLegalLineHtml(tenant) + '</p>';

  return '<footer class="bk-footer"' + (opts.attrs || '') + '>' +
    (opts.wrap ? bkColorBandInnerWrap(inner) : inner) + '</footer>';
}

/** The active template's footer for this shop (the shared one when it's switched on). */
function siteFooterHtmlForTheme(tenant) {
  if (isCharterTheme(tenant)) return '';
  if (isLuxeTheme(tenant)) return luxeLegalFooterHtml(tenant);
  if (isBladeTheme(tenant)) return bladeSiteFooterHtml(tenant);
  if (isStonecutTheme(tenant)) return stonecutSiteFooterHtml(tenant);
  if (isStudio12Theme(tenant)) return studio12SiteFooterHtml(tenant);
  return classicSiteFooterHtml(tenant);
}

/**
 * Web editor preview: re-render just the footer with unsaved settings, so switching a block on
 * or off shows immediately. `settings` is { webFooter, instagramHandle }.
 */
function previewSiteFooter(settings) {
  var tenant = window.__bkFooterTenant;
  var current = document.querySelector('footer.bk-footer, footer[data-bk-surface-key$=".footer"], footer[data-bk-surface-key="luxe.legal"]');
  if (!tenant || !current) return false;
  settings = settings || {};
  tenant.webFooter = settings.webFooter && typeof settings.webFooter === 'object' ? settings.webFooter : {};
  if (typeof settings.instagramHandle === 'string') tenant.instagramHandle = settings.instagramHandle;
  var html = siteFooterHtmlForTheme(tenant);
  if (!html) return false;
  var holder = document.createElement('div');
  holder.innerHTML = html;
  var next = holder.firstElementChild;
  if (!next) return false;
  current.parentNode.replaceChild(next, current);
  // The new element needs the same color and text treatment the first render got.
  applyColorSurfaceBands(tenant);
  applyWebSurfaceColors(tenant);
  applyWebButtonColors(tenant);
  applyWebTextStyles(tenant);
  return true;
}
