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

/* "Powered by Get Bookking" line under every shop page. Sits outside #root so page changes keep it. */
function mountPoweredByBadge() {
  if (isTemplatePreview() || document.getElementById('bk-powered')) return;
  var a = document.createElement('a');
  a.id = 'bk-powered';
  a.href = 'https://www.getbookking.com/?utm_source=booking_site&utm_medium=powered_by&utm_campaign=' +
    encodeURIComponent(location.hostname);
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', 'Powered by Get Bookking');
  a.innerHTML = '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAA2CAYAAAB3Ep8CAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAABAoAMABAAAAAEAAAA2AAAAADDDV98AAAGdaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6UGl4ZWxYRGltZW5zaW9uPjkzNzwvZXhpZjpQaXhlbFhEaW1lbnNpb24+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj43OTE8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4K87A5ggAAEMtJREFUaAXtWglwG9d5frvA4gYBEgQP8T4k8RApmpRIkdZByZFEu5bKuGbtRHVrT1t5ksZuJkebqdMJZzLpdFIndZ04HScTO9M4tkM6dmzL1C2SEg/xPkCAJIiLAIEFsMAujsUN7HZXDliIJiVKsaiM68Vg/7fv/e8/vnf+bxeAz6/PEbhvCLz5w68cQhcud82M9JfcLyO490vxi9/8UmaenP8vORLoGBArnIwdX7sftsD3QymrsyRH2iQVcus8ThSIEdD2+uuvy++HLfcFgNOnGxCpRHRUIOApw4EAQBKR0r31FQf+3wBwovpIsYQPHhTw+BTpdeEJrwVSSISPMQBAWw3CfekBXB54UCTgVpOwaPz989efx60GDw8Ej3b19GR+5gF4ufO5NMbZIxKRSLDsDF54/fUPUMxp7xPT/rwHinJbP/MAlOelVSFUtDkBC2yj0/r3zCSYXTJZr4QJKy3hRx+naXpLh8GWDgGa7oR5FHlEgHBLAxD/ve//5H9mZPkg8M5HI4uo1eTgRjxHz53rK9rKXrClAFzqFuTTQfIQzOMnZrT2s4yjlEAAKJ3WgjgcxHVBwpe+vTjt6GcWACgabgTRQH2CK5n82a/eX2AchXU6EJGLeN4plX6GxG0JIQg83tXVxdkqELasB3QN/VgYwdBWhIcofBT/wzGVNsj2ANZRsUBkG53SGXHMaUSinubcotyyzxwAeSvxnX4Xuh8SyPALAzNjJWJAJ51URoU2p9XptTnwYX7cI80V8duSZfeabkkP6OzshH0etIWOhHfA0vQr73SddRQpi71J535lMoXhOCAGJxbmcKc1xgfe9ldffRVJlt9LuiUAnDpSqHCZLAd4Iilv2Rm5EgsFAn2M06mOCTL45rExjcuNueaRiKeppWVPeWr5vUpvCQBOu7ORcNpbOPIs7W/fOaetLk/D1zrUkMi0Ep6Ad9FgvQwF7EI5HHlyLc+9eL7nAFgsQ0KrYWE/B+LkUYjkgmFmFk+rOr7a/ZNOdarVUZkAuK6Pamcx1OIBYWd7r1otSZbfK3rPAfAY1MVW/XKzWJlNzutsozIx39/d3Z1YzyG+RLI8saD14x7vCCeIVeVEfXvW4/s081YBeO7h8rRvtzeUDXT9V2FPTw//01DC7vycBmNT0OvbJcnMGe873+sqKSnANpJdt11h48egmN7s7qOCOMSHyMc+ra1xV0cHR3X+RwWk4WqteqgrI2nDKgCF2woPFRbl/0CZKfxuRQ50XKfqL+js7P2jToxWNFXy5cXFA4I0mZQIxAc8Tif5xojOn1S+lnZ2q6MCEdd9eUA1jzlsKCfifuTMmT7FWr47fIZU77+UXfjkroMSnuiFeCL8mlOnP5mUsQqAWIQ8UFdd2pot4fw9L+T8JcePfvfJNvyASnUpG4C7C1BQnW2XbXllb2ZunnVoeHwlR6lAmUhndf1PGpFKEZHEqNPZgw4XcZVDYqVl+Zz9qeV3kh7q6swY/eDFPTCX+nqGQPCaiEM9G7Cbq0cHrjYk5ay28IXL04NpUnFDGjdyMhKNZorkmX8HSXOOIaHAb+avd78XE10z1NYeIJIVb0fHx19FzH0zLVSCKuKKpZeM8xqPck+NHSw6blmVX77PIXdfqNQuY32lRbYOkbzk8S6a/vAvIWjdeWM9Yb2vfFWSXlBYBKLUCQEn8WUuFamJhYOACPlojd6uO3959Eqy3ioAc/bYGHJx8k0Zv36vTITkLiyaB4OhaFSZrXxWpsw6Jc3Mu7bQ/+szlLLyWlXVHjQpYCMq8od3aqanjivzCwITk5olAcWzdncPhzbiT+azE+QTe7Idl6+qoZqyrPGSjJVHy6dGdzHlM0mejei//3OH7HBt5T4eFzopSkQOh2KhQp83qInGYxNiHqeBDMddH50fGnZg7v6kjNUh8FfP46Ta5NFqjc4RBOGC7Jpmy7jK/OPpydk3ZodHUNXIQLthfOB7PtWlF/Rjv39kdnY2PSlkLWUnv+VFQxPpIyulGRmLevVCRChD9Gv5NnqmaLGFiRq5dszfE8FXZKKE+9GNeNn8p1uLBZd+9tyBIzWl3xLB0e/F/PhTTpsNNi4ZPuwf1rzpC4M5mqLA/KLFYDQ7r6l9YHUfstoDOjsBtUOasGgM6GC2jHt0V9vBxroTp/7NP3HpFQuzR09YsaN280qjMs/8TIHN2qjI111cnrrQE607Or4dgiKpBuqmqhSLqtf2i9NkQpvD5QiHg1ha/XE3mO1OZdswXX3C4Nd+mBcZnbOMF29LxzIyHH8+Y7e/tDsnJ7CmEvfcf56ulYiQh3gwdTzscdf7w2HM7nBfxn2hQYvNNwDJs5USibDD43W5R2b0s4FQsDdVxioAbKbW7yeqPWmTsxrTTHalvqmhseXY177z/Z+ePv0FTGPGF8w2vNlmdx/BbPb6zG36f8y3LDfK9XM9i3NXrtiww+rDh6E4Kwc36WtsZlvD9qoKdHBkhitCuBMbrf0s/9qLbYy/bgTWea01y72naCAziD0s8K48wPAN/IEXeqPzVKVSLmjl09E2L+Zphqg47sK9/SjmH0fx8DAZCmoXjZ7E888f3AdHA7u0BnTctOzqH7GGrKn6bgKAKUhIJII5B06eGRscqmvb2fil3Sfbep79+bnFV083zC9h2+y4wzm7YLAdFqOOQ04U3Z1tNtfmrFgOKAoWemwGzcXcEhp9+wc/bGGm+gIY4c4QTldEIgPqVKWbSdPhuFXOAwVG1HepsBA9ISFdT4COruFXCt7dtrNYfjBGek/6MeyANxYNuQjPkMcTGXZ7YxPecEwX8fCdv57Vhf/maN2+dAm1n2mw+LjaNOFPxIYY3TetQp84eNhpIcJQniKB2e315VVV1ek52bb3z/eNnJlA40MLlsBDlflEOM4zhGKUwef34aTLJQp48Jagl9jjRg35c9fH5aqR6+0ZWVkyq9XpJzD8Ste0u28zTqfyzDoCscai7Dyj209U5EmbZYrMmi8X2gngN58K+bzPEDhR5HRg00ar+5zdFXsXD9HXwnRQ94tenX3W4Yg9VJGXcez4g83iROCUdsGknZxHz+QYiCHN7QBgGRp2pPtJMirwu90Hv3Di0W00auib0KMu1sAhvSM2veLyMDwWXkbWRDwMVG43sexx2eVWg+GEc9nQSkUjZWVVlVMTI5PiNGHav05acV+qc5tN7y1Ni3mxgCIvR7oiiHmfQI2Lh4xGi9Juc31ksXvfRolYjy8Su8wPkQs/uapzTRiIZIQJPXp0/976ndknjfOLOwdVlrcSPOid9+0kuVb3J3oAy9Bu8kQ9hVkIarVVVz9QW1FUtM3x255rbPdZvaZNnvgJLRo2bxM4YK7YSsXi9kQi4o5HYtnydFkI95I2N4brguOWt9eivirkNglpqTeshNO3+2OUJkL6qiwrWK8bj3QRoeiElYipxTz+It63SPxyxRdNFdVarMw5eLC+mRt0tas0xjmj0//eRTXGmHFz92frrAtAH8O4d3dmgHB4ZDwu3Nx04JBEaFVfvs70R7ZS8upj+DQrvniT0uXzJDJMEiHPwIEhKwUh/bplFOLQ8O/ftvs3vfwl5SapyQSoyrxMjsPl43MggKLuwEwwGp92ehNaHDe5u6ex4HrgHmgsb9y3u+QBk1ZXN72EvstL8C5o3f61K8gNNesCwJa06/BwoDgLtqP2qrqmxgp5hsTcfWlsKmlcKp1AAaVBiUixOBcHAp/B6Y9bA3jIEBNxprSoP5bKe6fpKjnhJ8II8wJVZHe7QlqUgLFzCybS5AE3Vpy18lqVQNLQsq9FFPEdXNCvmMxY8KMLSw72APamyS9Zb0MA+pgKdXnpEYxwyTIUit1V1dUZXvXQeQ0W2XA3p8GwxLSZDEFWb8C7LegYmPEnx2RS3x1TDQYSxXgoyJFme383rw+YPJ51HU8KPvLgrtqq8sJK+/JytcboPg/FoH4dTq7b+myd1Z1gUkAqjZQuO4Vi+ejIwPU5iIfUPtLe9mBq+QZpmlnzomo1uGlcbsC7qew+AOLdzIEJw7xuK6YI4ZSVlOzA7WiuwxvSksHI/Fmd3Z1S/onkLQHo7gYJAQdWW5eNQ0taPVRRU/fFagB4n5DyJ5Lx9L7iAqFYoHQTfsTujc/D/jA78d04et/IxFsCwFbqnllBRXzx1f6L/WqeVHHkG19vWw0lNxJ6v/Lzd5bUkh5c5o9QPpvDMXnBQW54+JK08bYAMIxUZjZn0by0eNWyYuPs2NPSnqz8p0Q7StNlCpGkyO8PIQ436Q7ixBxj3+2GzPrL4FrHmIktXCrnQTSAqnbvra+XhFYuDy84bjm21sq4189HmiqaYaGwmvAHaIvZdn3YFtRuRudmegArhxLzZerpyakrOB5Q7N9/aPVIaTNK7jVPKwBcWYZ8VyiWoAgi5DbrXOxyfdvWZ+3aLADgvQUrTmDEVY1Gq83fsf3RP6uRbXgewAreymvHkfIiZU6mmErAUcZGlQGATW+9Nw0A4xDNEYjnJ4aHe6MJTmn7ybaDW+nkrXTJFNl7kLQsP+by+ubt1mnW1lvxp5bdCQBgwOz1mJf0582GZUdR6Xb2zc2WvL9LNXht+osVUoUyOzcrTlF+h8WqNnuBZy3PrZ7vCABGEK22huZGBkevCaSKfd84uZs9q7uvV3Z+WU1+VQW5oJrnji6sTDLGbLr1WcPvFADALKzkxNj0FbvTE2f23KvDoJOm4S66i8O8yIDZP5v+vz/NpNk/m0dvuP1m7IFaW1sF1R0dG2222AOcVZvZTVn+9pIiKhSBjEt6I3PQt+mxzzrPXmtPhD7Ovc0dNROj6mnVdFNTTT3Dynnxq23Naf/U/liMz818C7wFQYyNMBO+cSAu4DAU5n4AsZTxD+aLe/nDv3sxZAtKv/0XTz27err80xceK5LC3NPlZSU7RfIMDvH4vt4jT3zzZdaU87/4VgmJe54pLCupViiyEgFYNFhz6NTL+5rLCguKCgVzC0suy9zKOMt7p9ddAcDEt9j0jKqHiQ92N+ZJ5TMaYzgRDFqkQj6780LoBPPB48ftBAGmN1A0BUMQh+0ZPC4XivFlo964rPCmWGFuWB/3hfzOsRFNEEIgXjiGrO4zPjg7RIUIIpYpnzZJpGnRMBCwwQ0UhIUlGI4HpyZUM0z88YnDjs2AcdefpNUVA7mMllZCEoFKqcZCoBpwyMj6X3qG4gAqvmHNx3cHl0uf1enWBjdQRzVAyEg5VM7wRmQ66ucTIBlKQw+Xl/MkyjAs5nPpgFJMdTOv0WoK2aVYBlRmM3tOccso8Yb6dW53DcAfZLHjOdHQAJATVcfS8woUEBOBwTQUhWNxHiQUfswlFAEgZB5u/BiaplRQAp6MzpBJKGWGjCKBhGFkG1ACaCpBE0KEUjOv0FPfBv3HU8fET7/wD7CPjMClDR1+CIJuGeR8rPn297saAiliEw8/XM4vicJ/KxXQtVQ0JOaDBEJTNCIAYQQOw+xbRQjEYRAPh0EQicFULEqHAiTE4XJgKzMumA+mYxwYpvl8XgyGuVCUBmK+RC6UjE3/htHz36yul75yspYvpL+j6u8tEMgUghXDjwY7APhmNwN+ii13lfxjAQBNZ3Wxa6XpZvWS3c/sREMwzByGM/MfYLxh1iMIZgIIiMlkrIMSjLlxKMFMCUwzM7M5RFEUQylm1qSYxYuZJWAOhwtz+TyEi/D4M0mPBsdnnV4y9AH/4mQuF+FG+SKhmnH+jpa7pKzP6ecI3IzA/wJgJhpWnCvhjwAAAABJRU5ErkJggg==" alt="" width="20" height="17" />' +
    '<span>Powered by</span><span class="bk-powered-word">GET BOOKKING</span>';
  var wrap = document.createElement('div');
  wrap.className = 'bk-powered-wrap';
  wrap.appendChild(a);
  var css = document.createElement('style');
  css.textContent =
    '.bk-powered-wrap{display:flex;justify-content:center;padding:14px 16px 18px;}' +
    '#bk-powered{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-size:11px;' +
    'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif;color:#8a7a6a;opacity:.9;}' +
    '#bk-powered:hover{opacity:1;}#bk-powered img{width:20px;height:auto;display:block;}' +
    '.bk-powered-word{letter-spacing:.22em;font-weight:500;color:#5a4a3a;}' +
    '.bk-powered-wrap.is-dark #bk-powered{color:#9a8a7a;}.bk-powered-wrap.is-dark .bk-powered-word{color:#d8c8b0;}';
  document.head.appendChild(css);
  document.body.appendChild(wrap);
  // Match the page: light text on dark templates.
  function tone() {
    var el = document.body, bg = '';
    while (el) {
      bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) break;
      el = el.parentElement;
    }
    var m = (bg || '').match(/\d+(\.\d+)?/g);
    var lum = m ? (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) : 255;
    wrap.classList.toggle('is-dark', lum < 110);
  }
  tone();
  setTimeout(tone, 800);
}
