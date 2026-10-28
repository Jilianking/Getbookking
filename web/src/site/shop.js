/* Shop, cart, and checkout. */

function tenantShowShopPage(tenant) {
  return tenant.shopEnabled === true;
}

function tenantHasShopProducts(tenant) {
  return tenant._products && tenant._products.length > 0;
}

function tenantShouldBindShopCart(tenant) {
  return tenantShowShopPage(tenant) && tenantHasShopProducts(tenant);
}

function guidedWizardOrderedFields(fields) {
  var service = [];
  var project = [];
  var contact = [];
  var contactOrder = { name: 0, email: 1, phone: 2 };
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var bucket = guidedWizardBucketForField(f);
    if (bucket === 'service') service.push(f);
    else if (bucket === 'contact') contact.push(f);
    else project.push(f);
  }
  contact.sort(function(a, b) {
    var ao = contactOrder[a.key] != null ? contactOrder[a.key] : 99;
    var bo = contactOrder[b.key] != null ? contactOrder[b.key] : 99;
    return ao - bo;
  });
  return { service: service, project: project, contact: contact };
}

function shopCartStorageKey(tenantId) {
  return 'bk_shop_cart_v1_' + tenantId;
}

function readShopCart(tenantId) {
  try {
    var raw = localStorage.getItem(shopCartStorageKey(tenantId));
    if (!raw) return { lines: [] };
    var o = JSON.parse(raw);
    if (!o || !Array.isArray(o.lines)) return { lines: [] };
    return { lines: o.lines };
  } catch (e) {
    return { lines: [] };
  }
}

function writeShopCart(tenantId, cart) {
  try {
    localStorage.setItem(shopCartStorageKey(tenantId), JSON.stringify({ lines: cart.lines || [] }));
  } catch (e) {}
}

function findProductById(tenant, id) {
  var prods = tenant._products || [];
  for (var i = 0; i < prods.length; i++) {
    if (prods[i].id === id) return prods[i];
  }
  return null;
}

function addLineToShopCart(tenantId, prod, qty) {
  var q = parseInt(qty, 10);
  if (!q || q < 1) q = 1;
  var cart = readShopCart(tenantId);
  var found = false;
  for (var i = 0; i < cart.lines.length; i++) {
    if (cart.lines[i].productId === prod.id) {
      cart.lines[i].qty += q;
      cart.lines[i].name = prod.name || '';
      cart.lines[i].unitPrice = effectiveUnitPrice(prod);
      found = true;
      break;
    }
  }
  if (!found) {
    cart.lines.push({
      productId: prod.id,
      qty: q,
      name: prod.name || '',
      unitPrice: effectiveUnitPrice(prod)
    });
  }
  writeShopCart(tenantId, cart);
}

function updateShopCartLineQty(tenantId, id, delta) {
  var cart = readShopCart(tenantId);
  for (var i = 0; i < cart.lines.length; i++) {
    if (cart.lines[i].productId === id) {
      cart.lines[i].qty += delta;
      if (cart.lines[i].qty <= 0) cart.lines.splice(i, 1);
      break;
    }
  }
  writeShopCart(tenantId, cart);
}

function removeShopCartLine(tenantId, id) {
  var cart = readShopCart(tenantId);
  var next = [];
  for (var j = 0; j < cart.lines.length; j++) {
    if (cart.lines[j].productId !== id) next.push(cart.lines[j]);
  }
  cart.lines = next;
  writeShopCart(tenantId, cart);
}

function shopCartLineHtml(L) {
  var unit = Number(L.unitPrice) || 0;
  var pidAttr = esc(L.productId);
  return '<div class="bk-shop-line" data-product-id="' + pidAttr + '">' +
    '<div class="bk-shop-line-main">' +
    '<span class="bk-shop-line-name">' + esc(L.name) + '</span>' +
    '<span class="bk-shop-line-meta">' + formatMoney(unit) + ' × ' + L.qty + '</span>' +
    '</div>' +
    '<div class="bk-shop-line-actions">' +
    '<button type="button" class="bk-shop-line-dec" data-pid="' + pidAttr + '" aria-label="Decrease quantity">−</button>' +
    '<span class="bk-shop-line-qty">' + L.qty + '</span>' +
    '<button type="button" class="bk-shop-line-inc" data-pid="' + pidAttr + '" aria-label="Increase quantity">+</button>' +
    '<button type="button" class="bk-shop-line-remove" data-pid="' + pidAttr + '" aria-label="Remove">×</button>' +
    '</div></div>';
}

function updateShopCartNavCount(tenantId) {
  var navCount = document.getElementById('bk-shop-nav-count');
  if (!navCount) return;
  var cart = readShopCart(tenantId);
  var n = 0;
  for (var i = 0; i < cart.lines.length; i++) n += cart.lines[i].qty || 0;
  if (n > 0) {
    navCount.textContent = String(n);
    navCount.style.display = '';
  } else {
    navCount.textContent = '';
    navCount.style.display = 'none';
  }
}

function renderShopCartDrawer(tenantId) {
  var cartLinesEl = document.getElementById('bk-shop-cart-lines');
  var cartTotalEl = document.getElementById('bk-shop-cart-total');
  var checkoutBtn = document.getElementById('bk-shop-cart-checkout');
  if (!cartLinesEl) return;
  var cart = readShopCart(tenantId);
  var html = '';
  var total = 0;
  if (!cart.lines.length) {
    html = '<p class="bk-shop-cart-empty">Your cart is empty.</p>';
  } else {
    for (var li = 0; li < cart.lines.length; li++) {
      var L = cart.lines[li];
      var unit = Number(L.unitPrice) || 0;
      total += unit * (L.qty || 0);
      html += shopCartLineHtml(L);
    }
  }
  cartLinesEl.innerHTML = html;
  if (cartTotalEl) cartTotalEl.textContent = cart.lines.length ? ('Total ' + formatMoney(total)) : '';
  if (checkoutBtn) checkoutBtn.disabled = !cart.lines.length;
  updateShopCartNavCount(tenantId);
}

function refreshAllShopCartUIs(tenantId) {
  renderShopCartDrawer(tenantId);
  if (typeof window.__bkShopCheckoutRefresh === 'function') {
    window.__bkShopCheckoutRefresh();
  }
}

function bindShopCartLineDelegate() {
  if (window.__bkShopCartLineDelegate) return;
  window.__bkShopCartLineDelegate = true;
  document.addEventListener('click', function(ev) {
    var tenant = window.__bkShopActiveTenant;
    if (!tenant || !tenant.id) return;
    var btn = ev.target && ev.target.closest
      ? ev.target.closest('button.bk-shop-line-dec, button.bk-shop-line-inc, button.bk-shop-line-remove')
      : null;
    if (!btn) return;
    var container = btn.closest('#bk-shop-cart-lines, #bk-shop-checkout-summary');
    if (!container) return;
    ev.preventDefault();
    var pid = btn.getAttribute('data-pid');
    if (!pid) return;
    if (btn.classList.contains('bk-shop-line-dec')) updateShopCartLineQty(tenant.id, pid, -1);
    else if (btn.classList.contains('bk-shop-line-inc')) updateShopCartLineQty(tenant.id, pid, 1);
    else if (btn.classList.contains('bk-shop-line-remove')) removeShopCartLine(tenant.id, pid);
    refreshAllShopCartUIs(tenant.id);
  });
}

function closeShopDrawer() {
  var drawer = document.getElementById('bk-shop-cart-drawer');
  if (drawer) drawer.classList.remove('bk-shop-open');
}

function closeShopModal() {
  var modal = document.getElementById('bk-shop-modal');
  if (!modal) return;
  modal.classList.remove('bk-shop-open');
  if (modal.dataset) modal.dataset.currentProductId = '';
}

function openShopDrawer() {
  var drawer = document.getElementById('bk-shop-cart-drawer');
  var tenant = window.__bkShopActiveTenant;
  if (!drawer || !tenant || !tenant.id) return;
  drawer.classList.add('bk-shop-open');
  renderShopCartDrawer(tenant.id);
}

function bindShopChromeDelegate() {
  if (window.__bkShopChromeDelegate) return;
  window.__bkShopChromeDelegate = true;
  document.addEventListener('click', function(ev) {
    var el = ev.target;
    if (!el || !el.closest) return;
    if (el.closest('#bk-shop-nav-cart')) {
      ev.preventDefault();
      openShopDrawer();
      return;
    }
    if (el.closest('[data-bk-shop-close="drawer"]')) {
      var drawer = document.getElementById('bk-shop-cart-drawer');
      if (drawer && drawer.classList.contains('bk-shop-open')) {
        ev.preventDefault();
        closeShopDrawer();
      }
      return;
    }
    if (el.closest('[data-bk-shop-close="modal"]')) {
      var modal = document.getElementById('bk-shop-modal');
      if (modal && modal.classList.contains('bk-shop-open')) {
        ev.preventDefault();
        closeShopModal();
      }
      return;
    }
    if (el.closest('#bk-shop-cart-checkout')) {
      var tenant = window.__bkShopActiveTenant;
      if (!tenant || !tenant.id) return;
      var cart = readShopCart(tenant.id);
      if (!cart.lines.length) return;
      ev.preventDefault();
      closeShopDrawer();
      location.href = tenantBaseUrl(tenant) + '/shop/checkout';
      return;
    }
    if (el.closest('.bk-shop-modal-add')) {
      var tenantAdd = window.__bkShopActiveTenant;
      var modalAdd = document.getElementById('bk-shop-modal');
      if (!tenantAdd || !tenantAdd.id || !modalAdd) return;
      var pid = modalAdd.dataset && modalAdd.dataset.currentProductId;
      if (!pid) return;
      var prod = findProductById(tenantAdd, pid);
      if (!prod) return;
      ev.preventDefault();
      var mq = document.getElementById('bk-shop-modal-qty');
      var q = parseInt(mq && mq.value, 10) || 1;
      if (q < 1) q = 1;
      addLineToShopCart(tenantAdd.id, prod, q);
      closeShopModal();
      updateShopCartNavCount(tenantAdd.id);
      renderShopCartDrawer(tenantAdd.id);
    }
  });
  if (!window.__bkShopEscBound) {
    window.__bkShopEscBound = true;
    document.addEventListener('keydown', function(ev) {
      if (ev.key !== 'Escape') return;
      var m = document.getElementById('bk-shop-modal');
      var d = document.getElementById('bk-shop-cart-drawer');
      if (m && m.classList.contains('bk-shop-open')) {
        closeShopModal();
      } else if (d && d.classList.contains('bk-shop-open')) {
        closeShopDrawer();
      }
    });
  }
}

function formatShopCartNotes(cart) {
  var lines = cart && cart.lines ? cart.lines : [];
  if (!lines.length) return '';
  var parts = ['Products requested (from shop):'];
  var total = 0;
  for (var k = 0; k < lines.length; k++) {
    var L = lines[k];
    var unit = Number(L.unitPrice) || 0;
    var sub = unit * (L.qty || 0);
    total += sub;
    parts.push('- ' + (L.name || 'Item') + ' × ' + (L.qty || 0) + ' @ ' + formatMoney(unit) + ' = ' + formatMoney(sub));
  }
  parts.push('Estimated total: ' + formatMoney(total));
  return parts.join('\n');
}

function shopCartBagSvgHtml() {
  return '<svg class="bk-shop-nav-cart-icon" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M6 7h12l-1.2 11H7.2L6 7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path d="M9 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>';
}

function placeShopCartButton(cartBtn) {
  if (!cartBtn) return;
  var root = document.getElementById('root');
  if (shouldClassicMobileTopCart()) {
    var heroActions = root && root.querySelector('.classic-home-page .classic-hero-nav-actions');
    if (heroActions) {
      var heroMenu = heroActions.querySelector('.classic-hero-nav-menu, .tattoo-nav-menu');
      if (heroMenu) {
        if (cartBtn.parentNode !== heroActions || cartBtn.nextElementSibling !== heroMenu) {
          heroActions.insertBefore(cartBtn, heroMenu);
        }
        return;
      }
    }
    mountShopCartInNav(cartBtn);
    return;
  }
  mountShopCartInNav(cartBtn);
}

function mountShopCartInNav(cartBtn) {
  if (!cartBtn) return;
  var root = document.getElementById('root');
  if (!root) return;
  var s12Trailing = root.querySelector('.s12-nav-trailing');
  if (s12Trailing && root.querySelector('.studio12-page')) {
    var s12Book = s12Trailing.querySelector('.s12-nav-book');
    if (s12Book) {
      if (cartBtn.parentNode !== s12Trailing || cartBtn.nextElementSibling !== s12Book) {
        s12Trailing.insertBefore(cartBtn, s12Book);
      }
    } else if (cartBtn.parentNode !== s12Trailing) {
      s12Trailing.appendChild(cartBtn);
    }
    return;
  }
  var trailingSelectors = [
    '.blade-nav-trailing',
    '.stonecut-nav-trailing',
    '.luxe-nav-trailing',
    '.tattoo-nav-trailing'
  ];
  for (var i = 0; i < trailingSelectors.length; i++) {
    var trailing = root.querySelector(trailingSelectors[i]);
    if (!trailing) continue;
    var menuBtn = trailing.querySelector('.tattoo-nav-menu');
    if (menuBtn) {
      if (cartBtn.parentNode !== trailing || cartBtn.nextElementSibling !== menuBtn) {
        trailing.insertBefore(cartBtn, menuBtn);
      }
      return;
    }
  }
  var anyMenu = root.querySelector('.tattoo-nav-menu');
  if (anyMenu && anyMenu.parentNode && cartBtn.nextElementSibling !== anyMenu) {
    anyMenu.parentNode.insertBefore(cartBtn, anyMenu);
  }
}

function shopChromeHtml() {
  return '<div id="bk-shop-chrome">' +
    '<div class="bk-shop-modal" id="bk-shop-modal" role="dialog" aria-modal="true" aria-labelledby="bk-shop-modal-title">' +
    '<div class="bk-shop-modal-backdrop" data-bk-shop-close="modal"></div>' +
    '<div class="bk-shop-modal-panel">' +
    '<button type="button" class="bk-shop-modal-close" data-bk-shop-close="modal" aria-label="Close">&times;</button>' +
    '<div class="bk-shop-modal-media" id="bk-shop-modal-media">' +
    '<img id="bk-shop-modal-img" alt="" />' +
    '<div class="bk-shop-modal-media-placeholder" id="bk-shop-modal-ph" aria-hidden="true">◆</div>' +
    '</div>' +
    '<div class="bk-shop-modal-body">' +
    '<p class="bk-shop-modal-category" id="bk-shop-modal-category" hidden></p>' +
    '<h2 id="bk-shop-modal-title" class="bk-shop-modal-title"></h2>' +
    '<div class="bk-shop-modal-price-row"><span class="bk-shop-modal-price"></span></div>' +
    '<p class="bk-shop-modal-desc" id="bk-shop-modal-desc" hidden></p>' +
    '<div class="bk-shop-modal-actions">' +
    '<label class="bk-shop-modal-qty-label">Qty <input type="number" class="bk-shop-modal-qty" id="bk-shop-modal-qty" min="1" value="1" inputmode="numeric"></label>' +
    '<button type="button" class="bk-shop-modal-add">Add to cart</button>' +
    '</div></div></div></div>' +
    '<div class="bk-shop-cart-drawer" id="bk-shop-cart-drawer">' +
    '<div class="bk-shop-cart-drawer-backdrop" data-bk-shop-close="drawer"></div>' +
    '<div class="bk-shop-cart-drawer-panel">' +
    '<div class="bk-shop-cart-drawer-head"><h2>Your cart</h2><button type="button" class="bk-shop-drawer-close" data-bk-shop-close="drawer" aria-label="Close cart">&times;</button></div>' +
    '<div class="bk-shop-cart-lines" id="bk-shop-cart-lines"></div>' +
    '<div class="bk-shop-cart-footer">' +
    '<p class="bk-shop-cart-total" id="bk-shop-cart-total"></p>' +
    '<button type="button" class="bk-shop-cart-checkout" id="bk-shop-cart-checkout">Checkout</button>' +
    '</div></div></div>' +
    '<button type="button" class="bk-shop-nav-cart" id="bk-shop-nav-cart" aria-label="Open cart">' +
    shopCartBagSvgHtml() +
    '<span class="bk-shop-nav-count" id="bk-shop-nav-count" style="display:none"></span></button>' +
    '</div>';
}

function openShopProductModal(prod) {
  var m = document.getElementById('bk-shop-modal');
  if (!m || !prod) return;
  var mt = m.querySelector('.bk-shop-modal-title');
  var md = document.getElementById('bk-shop-modal-desc') || m.querySelector('.bk-shop-modal-desc');
  var mp = m.querySelector('.bk-shop-modal-price');
  var mq = document.getElementById('bk-shop-modal-qty');
  var cat = document.getElementById('bk-shop-modal-category');
  var media = document.getElementById('bk-shop-modal-media');
  var img = document.getElementById('bk-shop-modal-img');
  var ph = document.getElementById('bk-shop-modal-ph');
  m.dataset.currentProductId = prod.id;
  if (mt) mt.textContent = prod.name || '';
  if (cat) {
    var category = prod.category ? String(prod.category).trim() : '';
    cat.textContent = category;
    if (category) cat.removeAttribute('hidden');
    else cat.setAttribute('hidden', '');
  }
  if (md) {
    var desc = prod.description ? String(prod.description).trim() : '';
    md.textContent = desc;
    if (desc) md.removeAttribute('hidden');
    else md.setAttribute('hidden', '');
  }
  if (mp) {
    var ep = effectiveUnitPrice(prod);
    var orig = Number(prod.price) || 0;
    var saleN = prod.salePrice != null ? Number(prod.salePrice) : NaN;
    var onSale = !isNaN(saleN) && saleN < orig;
    mp.innerHTML = onSale
      ? '<span class="bk-shop-price-sale">' + formatMoney(ep) + '</span><span class="bk-shop-price-was">' + formatMoney(orig) + '</span>'
      : formatMoney(ep);
  }
  var imageUrl = prod.imageUrl ? String(prod.imageUrl).trim() : '';
  if (media && img && ph) {
    media.removeAttribute('hidden');
    if (imageUrl) {
      img.onload = function() {
        img.style.display = 'block';
        ph.style.display = 'none';
      };
      img.onerror = function() {
        img.removeAttribute('src');
        img.style.display = 'none';
        ph.style.display = 'flex';
      };
      img.alt = prod.name || 'Product';
      img.src = imageUrl;
      img.style.display = 'block';
      ph.style.display = 'none';
    } else {
      img.removeAttribute('src');
      img.alt = '';
      img.style.display = 'none';
      ph.style.display = 'flex';
    }
  }
  if (mq) mq.value = '1';
  m.classList.add('bk-shop-open');
}

function shopCheckoutCardStyle(tenant) {
  var c = tenantColors(tenant);
  if (isCharterTheme(tenant)) {
    return '--bk-checkout-card:var(--charter-surface);--bk-checkout-fg:var(--charter-ink);' +
      '--bk-checkout-muted:var(--charter-muted);--bk-checkout-border:var(--charter-line);' +
      '--bk-checkout-input-bg:color-mix(in srgb, var(--charter-ink) 4%, var(--charter-bg));' +
      '--bk-checkout-accent:var(--charter-accent);--bk-checkout-accent-fg:var(--charter-accent-ink);' +
      '--bk-checkout-shadow:none;';
  }
  var pageDark = isStonecutTheme(tenant);
  var checkoutCard = '#ffffff';
  var checkoutFg = pageDark ? '#111111' : (c.fg || '#111111');
  var muted = 'rgba(0,0,0,0.55)';
  var border = 'rgba(0,0,0,0.1)';
  var inputBg = '#f5f5f4';
  var shadow = pageDark
    ? '0 16px 48px rgba(0,0,0,0.45)'
    : '0 16px 48px rgba(0,0,0,0.12)';
  return '--bk-checkout-card:' + checkoutCard + ';--bk-checkout-fg:' + checkoutFg + ';--bk-checkout-muted:' + muted +
    ';--bk-checkout-border:' + border + ';--bk-checkout-input-bg:' + inputBg +
    ';--bk-checkout-accent:' + c.accent + ';--bk-checkout-accent-fg:' + c.accentFg +
    ';--bk-checkout-shadow:' + shadow + ';';
}

function shopCartSubtotal(cart) {
  var subtotal = 0;
  for (var i = 0; i < cart.lines.length; i++) {
    var L = cart.lines[i];
    subtotal += (Number(L.unitPrice) || 0) * (L.qty || 0);
  }
  return subtotal;
}

function shopCheckoutSubtitleLine(tenant) {
  return tenantSiteDisplayName(tenant, '');
}

function shopCheckoutFeeTooltipHtml(state) {
  var method = state && state.method;
  var label = (state && state.rateLabel) || '2.9% + 30\u00a2';
  var name = method === 'klarna' ? 'Klarna' : method === 'affirm' ? 'Affirm' : method === 'instant_bank' ? 'Bank' : 'Card processing';
  return '<p>' + name + ' (Stripe ' + label + ')</p>' +
    '<p>Platform fee (1%)</p>' +
    '<p class="bk-shop-fee-tip-note">The business receives the full service amount.</p>';
}
function checkoutStripeOptions(stripeAccountId) {
  return {
    stripeAccount: stripeAccountId,
    betas: ['change_event_improvements_beta_1']
  };
}
function checkoutMethodTitle(method) {
  if (method === 'klarna') return 'Klarna';
  if (method === 'affirm') return 'Affirm';
  if (method === 'instant_bank') return 'Bank';
  return 'Card';
}
/** Stripe can offer Klarna inside Link; it isn't allowed here (no processing fee on pay-later). */
var BLOCKED_CHECKOUT_METHOD_MESSAGE = 'Klarna isn\u2019t available for this business. Please pay with Card or Bank.';
function isBlockedCheckoutMethod(method) {
  return method === 'klarna' || method === 'affirm';
}
function isRepricedCheckoutMethod(method) {
  return method === 'card' || method === 'klarna' || method === 'affirm' || method === 'instant_bank';
}
function methodFromPaymentPreview(preview) {
  if (!preview) return '';
  var type = (preview.type || '').toString();
  if (type === 'klarna' || preview.klarna) return 'klarna';
  if (type === 'affirm' || preview.affirm) return 'affirm';
  var card = preview.card || {};
  var brand = (card.brand || '').toString().toLowerCase();
  if (brand === 'link' || type === 'link_card_brand') return 'instant_bank';
  if (type === 'card' && brand && brand !== 'unknown') return 'card';
  return '';
}
function methodFromLinkValue(value) {
  if (!value) return '';
  var preview = methodFromPaymentPreview(value.payment_method);
  if (preview === 'klarna' || preview === 'affirm' || preview === 'instant_bank') return preview;
  var blob = '';
  try { blob = JSON.stringify(value).toLowerCase(); } catch (e) { return ''; }
  if (blob.indexOf('klarna') !== -1) return 'klarna';
  if (blob.indexOf('affirm') !== -1) return 'affirm';
  if (blob.indexOf('link_card_brand') !== -1 || blob.indexOf('"brand":"link"') !== -1) return 'instant_bank';
  return '';
}
function methodFromChangeEvent(event) {
  var value = (event && event.value) || {};
  var type = (value.type || '').toString();
  var saved = methodFromPaymentPreview(value.payment_method);
  if (saved === 'instant_bank' || saved === 'klarna' || saved === 'affirm') return saved;
  if (type === 'klarna' || type === 'affirm') return type;
  if (type === 'link_card_brand' || type === 'instant_bank' || type === 'instant_bank_account') return 'instant_bank';
  if (type === 'link') return methodFromLinkValue(value);
  return '';
}
function bindCheckoutMethodReprice(config) {
  var initial = isRepricedCheckoutMethod(config.initialMethod) ? config.initialMethod : 'card';
  var selected = initial;
  var priced = initial;
  var queue = Promise.resolve();
  var generation = 0;
  var lastEvent = null;

  function previewCheckoutMethod(shouldSubmit) {
    if (!config.stripe || typeof config.stripe.createConfirmationToken !== 'function') {
      return Promise.resolve('');
    }
    var ready = Promise.resolve(true);
    if (shouldSubmit && config.elements && typeof config.elements.submit === 'function') {
      ready = config.elements.submit().then(function(res) {
        return !(res && res.error);
      }).catch(function() { return false; });
    }
    return ready.then(function(ok) {
      if (!ok) return '';
      return config.stripe.createConfirmationToken({ elements: config.elements }).then(function(result) {
        if (!result || result.error) return '';
        var token = result.confirmationToken;
        var preview = token && token.payment_method_preview;
        return methodFromPaymentPreview(preview) || methodFromLinkValue(preview);
      }).catch(function() {
        return '';
      });
    });
  }

  function reprice(method, paymentMethodId) {
    if (!isRepricedCheckoutMethod(method)) return Promise.resolve(null);
    if (isBlockedCheckoutMethod(method)) {
      selected = method;
      if (config.onNotice) config.onNotice(BLOCKED_CHECKOUT_METHOD_MESSAGE);
      return Promise.resolve(null);
    }
    if (config.onNotice) config.onNotice('');
    selected = method;
    if (priced === method && !paymentMethodId) return Promise.resolve(null);
    if (config.onUpdating) config.onUpdating(method);
    return ensureAnonymousAuth().then(function() {
      return functions.httpsCallable('repriceCustomerCheckout')({
        tenantSlug: config.tenantSlug,
        paymentIntentId: config.paymentIntentId,
        method: method,
        paymentMethodId: paymentMethodId || ''
      });
    }).then(function(res) {
      var data = (res && res.data) || {};
      var resolved = data.method || method;
      if (selected !== method && selected !== resolved) return null;
      selected = resolved;
      priced = resolved;
      return config.elements.fetchUpdates().then(function() { return data; });
    }).then(function(data) {
      if (!data) return null;
      var resolved = data.method || method;
      if (selected !== resolved && selected !== method) return null;
      if (config.onPriced) config.onPriced(data);
      return data;
    });
  }

  function resolveEvent(event) {
    var gen = ++generation;
    var hinted = methodFromChangeEvent(event);
    var type = (event && event.value && event.value.type) || '';
    var pmId = (event && event.value && event.value.payment_method && event.value.payment_method.id) || '';
    if (hinted && (elementReady || hinted === 'card')) selected = hinted;
    var pmFor = function(method) {
      var preview = methodFromPaymentPreview(event && event.value && event.value.payment_method);
      return preview === method ? pmId : '';
    };
    queue = queue.then(function() {
      if (gen !== generation) return null;
      if (!elementReady && hinted && hinted !== 'card') return null;
      if (hinted === 'klarna' || hinted === 'affirm' || hinted === 'instant_bank') {
        if (hinted !== 'card') userPicked = true;
        return reprice(hinted, pmFor(hinted));
      }
      var complete = !!(event && event.complete);
      if (type === 'link' || (complete && (type === 'card' || type === 'link_card_brand'))) {
        // Stripe only reveals a Link bank (card brand "link") after elements.submit().
        // Never for Apple Pay / Google Pay: submit() would open their sheet unprompted.
        return previewCheckoutMethod(complete).then(function(previewed) {
          if (gen !== generation) return null;
          var fromValue = type === 'link' ? methodFromLinkValue(event && event.value) : '';
          var method = previewed || fromValue;
          if (!method && type === 'link_card_brand') method = 'instant_bank';
          if (!method && type === 'card') method = 'card';
          if (!method) return null;
          if (!elementReady && method !== 'card') return null;
          if (method !== 'card') userPicked = true;
          return reprice(method, pmFor(method));
        });
      }
      if (type === 'card' && !complete) {
        return reprice('card', pmFor('card'));
      }
      return reprice(hinted || 'card', pmFor(hinted || 'card'));
    }).catch(function(err) {
      if (config.onError) config.onError(err);
      return null;
    });
    return queue;
  }

  var paymentChanges = 0;
  var bankFormSelected = false;
  var elementReady = false;
  var userPicked = false;
  function applyDetectedMethod(method) {
    if (!method) return;
    if (!elementReady && method !== 'card') return;
    if (elementReady && method !== 'card') userPicked = true;
    if (method === priced) return;
    generation += 1;
    selected = method;
    queue = queue.then(function() { return reprice(method); }).catch(function(err) {
      if (config.onError) config.onError(err);
      return null;
    });
  }
  config.paymentElement.on('change', function(event) {
    paymentChanges += 1;
    lastEvent = event;
    var type = event && event.value && event.value.type;
    var hinted = methodFromChangeEvent(event);
    if (hinted || type === 'card' || type === 'link' || type === 'link_card_brand') resolveEvent(event);
  });
  if (typeof config.paymentElement.on === 'function') {
    config.paymentElement.on('carddetailschange', function(event) {
      if (!event || event.loading) return;
      if (paymentChanges < 1) return;
      var details = event.details;
      var lastType = (lastEvent && lastEvent.value && lastEvent.value.type) || '';
      if (!details) {
        if (!elementReady) return;
        if (lastType === 'klarna' || lastType === 'affirm') return;
        if (lastType === 'link') {
          previewCheckoutMethod().then(function(previewed) {
            var fromValue = methodFromLinkValue(lastEvent && lastEvent.value);
            var method = previewed || fromValue;
            if (method) applyDetectedMethod(method);
          }).catch(function() {});
          return;
        }
        bankFormSelected = true;
        applyDetectedMethod('instant_bank');
        return;
      }
      var brands = details.brands || [];
      var linkBrand = false;
      for (var i = 0; i < brands.length; i++) {
        if (String(brands[i] || '').toLowerCase() === 'link') linkBrand = true;
      }
      if (linkBrand) {
        bankFormSelected = true;
        applyDetectedMethod('instant_bank');
        return;
      }
      bankFormSelected = false;
      applyDetectedMethod('card');
    });
  }
  if (typeof config.paymentElement.on === 'function') {
    config.paymentElement.on('ready', function() {
      elementReady = true;
      if (!userPicked && config.openOnCard !== false) applyDetectedMethod('card');
    });
  }
  config.prepareConfirm = function() {
    elementReady = true;
    return resolveEvent(lastEvent).then(function() {
      if (priced !== selected) return resolveEvent(lastEvent);
    }).then(function() {
      if (isBlockedCheckoutMethod(selected)) {
        throw new Error(BLOCKED_CHECKOUT_METHOD_MESSAGE);
      }
      if (priced !== selected) {
        throw new Error('The total is still updating for this payment method. Try again.');
      }
    });
  };
  return config;
}
/**
 * Apple Pay / Google Pay must open right after the tap, so elements.submit() runs first and
 * any server work (repricing, saving contact details) comes after it.
 */
function confirmCheckoutPayment(prepare, stripe, elements, confirmParams, beforeConfirm) {
  var submitted = (elements && typeof elements.submit === 'function')
    ? elements.submit()
    : Promise.resolve({});
  return submitted.then(function(res) {
    if (res && res.error) return { error: res.error };
    var ready = (typeof prepare === 'function') ? prepare() : Promise.resolve();
    return ready.then(function() {
      return (typeof beforeConfirm === 'function') ? beforeConfirm() : null;
    }).then(function() {
      return stripe.confirmPayment({
        elements: elements,
        redirect: 'if_required',
        confirmParams: confirmParams
      });
    });
  });
}
function depositPayPageHtml(tenant) {
  var name = tenantSiteDisplayName(tenant, 'Payment');
  return '<div class="container" style="max-width:440px;margin:48px auto;padding:0 16px">' +
    '<div class="card" id="bk-pay-card" style="padding:28px 24px">' +
    '<p id="bk-pay-business" style="margin:0 0 8px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;opacity:.6">' + esc(name) + '</p>' +
    '<h1 id="bk-pay-title" style="margin:0 0 18px;font-size:22px">Payment</h1>' +
    '<div id="bk-pay-summary" style="display:none;margin-bottom:16px;font-size:15px">' +
    '<div style="display:flex;justify-content:space-between;margin:6px 0"><span>Service</span><span id="bk-pay-service"></span></div>' +
    '<div style="display:flex;justify-content:space-between;margin:6px 0"><span>Processing &amp; service fees</span><span id="bk-pay-fee"></span></div>' +
    '<div style="display:flex;justify-content:space-between;margin:10px 0 0;font-weight:650"><span>Customer pays</span><span id="bk-pay-total"></span></div>' +
    '<p id="bk-pay-rate" style="margin:8px 0 0;font-size:13px;opacity:.65"></p>' +
    '</div>' +
    '<p id="bk-pay-status" style="margin:0 0 12px">Loading payment…</p>' +
    '<div id="bk-pay-element"></div>' +
    '<p id="bk-pay-error" style="display:none;color:#9b2c2c;margin:12px 0 0"></p>' +
    '<button type="button" id="bk-pay-button" style="display:none;width:100%;margin-top:16px" class="btn">Pay</button>' +
    '</div></div>';
}
function bindDepositPayPage(tenant) {
  var params;
  try { params = new URLSearchParams(location.search || ''); } catch (e) { params = null; }
  var pi = params ? (params.get('pi') || '') : '';
  var statusEl = document.getElementById('bk-pay-status');
  var errorEl = document.getElementById('bk-pay-error');
  var summaryEl = document.getElementById('bk-pay-summary');
  var button = document.getElementById('bk-pay-button');
  function showPayError(msg) {
    if (!errorEl) return;
    errorEl.style.display = msg ? 'block' : 'none';
    errorEl.textContent = msg || '';
  }
  function money(cents) {
    return (typeof formatMoney === 'function') ? formatMoney((Number(cents) || 0) / 100) : ('$' + ((Number(cents) || 0) / 100).toFixed(2));
  }
  function paintSummary(data) {
    if (summaryEl) summaryEl.style.display = '';
    var serviceEl = document.getElementById('bk-pay-service');
    var feeEl = document.getElementById('bk-pay-fee');
    var totalEl = document.getElementById('bk-pay-total');
    var rateEl = document.getElementById('bk-pay-rate');
    if (serviceEl) serviceEl.textContent = money(data.serviceCents);
    if (feeEl) feeEl.textContent = data.surchargeCents == null ? '…' : money(data.surchargeCents);
    if (totalEl) totalEl.textContent = data.totalCents == null ? '…' : money(data.totalCents);
    if (rateEl) {
      var method = checkoutMethodTitle(data.method);
      rateEl.textContent = method + ' · Stripe ' + (data.rateLabel || '2.9% + 30¢') + ' plus a 1% platform fee.';
    }
    if (button && data.totalCents != null) button.textContent = 'Pay ' + money(data.totalCents);
  }
  if (!pi || pi.indexOf('pi_') !== 0) {
    if (statusEl) statusEl.textContent = 'This payment link is missing its payment.';
    return;
  }
  if (params && params.get('redirect_status') === 'succeeded') {
    if (statusEl) statusEl.textContent = 'Payment received. Thank you.';
    return;
  }
  ensureAnonymousAuth().then(function() {
    var stripeReady = (window.BKSitePerf && window.BKSitePerf.ensureStripe)
      ? window.BKSitePerf.ensureStripe()
      : Promise.resolve();
    return stripeReady.then(function() {
      return functions.httpsCallable('getDepositCheckout')({
        tenantSlug: tenant.slug,
        paymentIntentId: pi
      });
    });
  }).then(function(res) {
    var data = (res && res.data) || {};
    var title = document.getElementById('bk-pay-title');
    if (title) title.textContent = data.productName || 'Payment';
    if (data.paid) {
      if (statusEl) statusEl.textContent = 'Payment received. Thank you.';
      paintSummary(data);
      return;
    }
    if (!data.clientSecret || !data.stripeAccountId) {
      throw new Error('Could not start payment.');
    }
    if ((data.method || 'card') === 'card') {
      paintSummary(data);
    } else {
      paintSummary({
        serviceCents: data.serviceCents,
        method: 'card',
        rateLabel: '2.9% + 30¢'
      });
    }
    if (statusEl) statusEl.style.display = 'none';
    if (typeof Stripe !== 'function') throw new Error('Stripe.js did not load.');
    var pk = shopStripePublishableKey(data.publishableKey);
    var stripe = Stripe(pk, checkoutStripeOptions(data.stripeAccountId));
    var elements = stripe.elements({
      clientSecret: data.clientSecret,
      appearance: shopPaymentElementAppearance(tenant)
    });
    var paymentElement = elements.create('payment', { layout: 'tabs' });
    paymentElement.mount('#bk-pay-element');
    if (button) button.style.display = '';
    var payState = data;
    var depositReprice = bindCheckoutMethodReprice({
      tenantSlug: tenant.slug,
      paymentIntentId: pi,
      initialMethod: data.method || 'card',
      openOnCard: true,
      paymentElement: paymentElement,
      elements: elements,
      stripe: stripe,
      onPriced: function(priced) {
        payState = priced;
        paintSummary(priced);
        showPayError('');
      },
      onError: function(err) { showPayError(formatFirebaseHttpsError(err)); },
      onNotice: function(msg) { showPayError(msg || ''); }
    });
    if (button) {
      button.addEventListener('click', function() {
        button.disabled = true;
        showPayError('');
        confirmCheckoutPayment(
          depositReprice.prepareConfirm,
          stripe,
          elements,
          { return_url: location.href }
        ).then(function(result) {
          if (result.error) throw result.error;
          if (statusEl) {
            statusEl.style.display = '';
            statusEl.textContent = 'Payment received. Thank you.';
          }
          if (button) button.style.display = 'none';
          var mount = document.getElementById('bk-pay-element');
          if (mount) mount.innerHTML = '';
        }).catch(function(err) {
          button.disabled = false;
          showPayError((err && err.message) ? err.message : formatFirebaseHttpsError(err));
        });
      });
    }
  }).catch(function(err) {
    if (statusEl) statusEl.textContent = 'This payment link could not be opened.';
    showPayError(formatFirebaseHttpsError(err));
  });
}

function updateShopCheckoutSummary(cart, stripeState, contactOk, isPreparing) {
  var summaryEl = document.getElementById('bk-shop-checkout-summary');
  if (!summaryEl) return;
  if (!cart.lines.length) {
    summaryEl.style.display = 'none';
    return;
  }
  summaryEl.style.display = '';
  var subtotalEl = document.getElementById('bk-shop-checkout-subtotal');
  var feeEl = document.getElementById('bk-shop-checkout-fee');
  var totalEl = document.getElementById('bk-shop-checkout-total');
  var totalRow = document.getElementById('bk-shop-checkout-total-row');
  var tipEl = document.getElementById('bk-shop-fee-tip');
  var cartSubtotal = shopCartSubtotal(cart);
  var subtotalCents = stripeState && stripeState.subtotalCents != null
    ? stripeState.subtotalCents
    : Math.round(cartSubtotal * 100);
  if (subtotalEl) subtotalEl.textContent = formatMoney(subtotalCents / 100);
  var shippingRow = document.getElementById('bk-shop-checkout-shipping-row');
  var shippingEl = document.getElementById('bk-shop-checkout-shipping');
  var shippingCents = stripeState && stripeState.shippingCents != null
    ? stripeState.shippingCents
    : 0;
  if (shippingRow && shippingEl) {
    if (shippingCents > 0 || (stripeState && stripeState.fulfillmentMethod === 'shipping')) {
      shippingRow.style.display = '';
      shippingEl.textContent = formatMoney(shippingCents / 100);
    } else {
      shippingRow.style.display = 'none';
    }
  }
  var taxRow = document.getElementById('bk-shop-checkout-tax-row');
  var taxEl = document.getElementById('bk-shop-checkout-tax');
  var taxCents = stripeState && stripeState.taxCents != null ? stripeState.taxCents : 0;
  if (taxRow && taxEl) {
    if (taxCents > 0) {
      taxRow.style.display = '';
      taxEl.textContent = formatMoney(taxCents / 100);
    } else {
      taxRow.style.display = 'none';
    }
  }
  if (feeEl) {
    if (stripeState && stripeState.surchargeCents != null) {
      feeEl.textContent = formatMoney(stripeState.surchargeCents / 100);
      feeEl.className = 'bk-shop-checkout-summary-amount';
    } else if (isPreparing) {
      feeEl.textContent = 'Calculating\u2026';
      feeEl.className = 'bk-shop-checkout-summary-amount bk-shop-checkout-summary-fee-pending';
    } else {
      feeEl.textContent = contactOk ? 'Calculated at checkout' : 'Calculated at checkout';
      feeEl.className = 'bk-shop-checkout-summary-amount bk-shop-checkout-summary-fee-pending';
    }
  }
  if (totalRow && totalEl) {
    if (stripeState && stripeState.totalCents != null) {
      totalRow.style.display = '';
      totalEl.textContent = formatMoney(stripeState.totalCents / 100);
    } else {
      totalRow.style.display = 'none';
    }
  }
  if (tipEl) tipEl.innerHTML = shopCheckoutFeeTooltipHtml(stripeState);
}

function shopCheckoutPickupAddress(tenant) {
  var name = tenantSiteDisplayName(tenant, 'Studio');
  var city = (tenant.serviceCity && String(tenant.serviceCity).trim()) ||
    (tenant.serviceArea && String(tenant.serviceArea).trim()) || '';
  var street = tenantStreetAddressText(tenant);
  var line = street ? street.split('\n')[0] : '';
  if (city && line) return name + ', ' + line + ', ' + city;
  if (city) return name + ', ' + city;
  if (line) return name + ', ' + line;
  return name;
}

function shopCheckoutInnerHtml(tenant) {
  var cardStyle = shopCheckoutCardStyle(tenant);
  var pickupAddr = esc(shopCheckoutPickupAddress(tenant));
  return '<div class="bk-shop-checkout-page">' +
    '<div class="bk-shop-checkout-card" style="' + cardStyle + '">' +
    '<div class="bk-shop-checkout-head">' +
    '<h1>Checkout</h1>' +
    '<p class="bk-shop-checkout-subtitle" id="bk-shop-checkout-subtitle">' + esc(shopCheckoutSubtitleLine(tenant)) + '</p>' +
    '</div>' +
    '<div class="bk-shop-checkout-empty" id="bk-shop-checkout-empty" style="display:none">' +
    '<p>Your cart is empty.</p>' +
    '<p style="margin-top:12px"><a href="' + esc(tenantBaseUrl(tenant) + '/shop') + '">Continue shopping</a></p>' +
    '</div>' +
    '<form id="bk-shop-checkout-form" autocomplete="on">' +
    '<div class="bk-shop-checkout-field">' +
    '<label for="bk-shop-checkout-name">Full name</label>' +
    '<input id="bk-shop-checkout-name" name="name" type="text" required autocomplete="name" placeholder="Your name">' +
    '</div>' +
    '<div class="bk-shop-checkout-field">' +
    '<label for="bk-shop-checkout-email">Email</label>' +
    '<span class="bk-shop-checkout-field-hint">We\'ll send your receipt here</span>' +
    '<input id="bk-shop-checkout-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com">' +
    '</div>' +
    '<div class="bk-shop-checkout-field">' +
    '<label for="bk-shop-checkout-phone">Phone <span style="font-weight:400;opacity:0.7">(optional)</span></label>' +
    '<span class="bk-shop-checkout-field-hint">For order updates</span>' +
    '<input id="bk-shop-checkout-phone" name="phone" type="tel" autocomplete="tel" placeholder="(555) 555-0134">' +
    '</div>' +
    (function() {
      var pickupOn = tenant.shopPickupEnabled !== false;
      var shipOn = tenant.shopShippingEnabled === true;
      if (!pickupOn && !shipOn) pickupOn = true;
      var html = '<div class="bk-shop-checkout-section"><p class="bk-shop-checkout-section-label">How would you like to get it?</p><div class="bk-shop-checkout-fulfillment-options" id="bk-shop-fulfillment-options">';
      if (pickupOn) {
        html += '<button type="button" class="bk-shop-checkout-fulfillment-option" data-fulfillment="pickup" aria-pressed="true">' +
          '<svg class="bk-shop-checkout-fulfillment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 9l9-5 9 5v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9z"/><path d="M9 22V12h6v10"/></svg>' +
          '<span><span class="bk-shop-checkout-fulfillment-title">Pickup</span><span class="bk-shop-checkout-fulfillment-sub">Free · ready when prepared</span></span></button>';
      }
      if (shipOn) {
        html += '<button type="button" class="bk-shop-checkout-fulfillment-option" data-fulfillment="shipping" aria-pressed="' + (pickupOn ? 'false' : 'true') + '">' +
          '<svg class="bk-shop-checkout-fulfillment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 7h11v10H3z"/><path d="M14 10h4l3 3v4h-7V10z"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>' +
          '<span><span class="bk-shop-checkout-fulfillment-title">Ship</span><span class="bk-shop-checkout-fulfillment-sub">Live USPS / UPS rates</span></span></button>';
      }
      html += '</div>';
      if (pickupOn && tenant.shopShowPickupAddressOnCheckout !== false) html += '<p class="bk-shop-checkout-pickup-address" id="bk-shop-pickup-address">' + pickupAddr + '</p>';
      if (shipOn) {
        html += '<div class="bk-shop-checkout-ship-fields" id="bk-shop-ship-fields"' + (pickupOn ? ' hidden' : '') + '>' +
          '<div class="bk-shop-checkout-field"><label for="bk-shop-ship-street">Street</label><input id="bk-shop-ship-street" name="shipStreet" type="text" autocomplete="shipping address-line1" placeholder="123 Main St"></div>' +
          '<div class="bk-shop-checkout-field"><label for="bk-shop-ship-street2">Apt / suite <span style="font-weight:400;opacity:0.7">(optional)</span></label><input id="bk-shop-ship-street2" name="shipStreet2" type="text" autocomplete="shipping address-line2"></div>' +
          '<div class="bk-shop-checkout-field"><label for="bk-shop-ship-city">City</label><input id="bk-shop-ship-city" name="shipCity" type="text" autocomplete="shipping address-level2"></div>' +
          '<div class="bk-shop-checkout-field"><label for="bk-shop-ship-state">State</label><input id="bk-shop-ship-state" name="shipState" type="text" autocomplete="shipping address-level1" maxlength="2" placeholder="FL"></div>' +
          '<div class="bk-shop-checkout-field"><label for="bk-shop-ship-zip">ZIP</label><input id="bk-shop-ship-zip" name="shipZip" type="text" autocomplete="shipping postal-code" inputmode="numeric"></div>' +
          '<button type="button" class="bk-shop-modal-add" id="bk-shop-get-rates" style="width:100%;margin-top:4px">Get shipping rates</button>' +
          '<p class="bk-shop-checkout-rates-status" id="bk-shop-rates-status"></p>' +
          '<div class="bk-shop-checkout-rates" id="bk-shop-rates"></div></div>';
      }
      html += '</div>';
      return html;
    })() +
    '<button type="button" class="bk-shop-checkout-note-toggle" id="bk-shop-checkout-note-toggle">+ Add a note</button>' +
    '<div class="bk-shop-checkout-notes-wrap" id="bk-shop-checkout-notes-wrap" hidden>' +
    '<div class="bk-shop-checkout-field" style="margin-bottom:0">' +
    '<textarea id="bk-shop-checkout-notes" name="notes" rows="3" placeholder="Special instructions"></textarea>' +
    '</div></div>' +
    '<div class="bk-shop-checkout-summary" id="bk-shop-checkout-summary">' +
    '<div class="bk-shop-checkout-summary-row">' +
    '<span class="bk-shop-checkout-summary-label">Subtotal</span>' +
    '<span class="bk-shop-checkout-summary-amount" id="bk-shop-checkout-subtotal">$0.00</span>' +
    '</div>' +
    '<div class="bk-shop-checkout-summary-row" id="bk-shop-checkout-shipping-row" style="display:none">' +
    '<span class="bk-shop-checkout-summary-label">Shipping</span>' +
    '<span class="bk-shop-checkout-summary-amount" id="bk-shop-checkout-shipping">$0.00</span>' +
    '</div>' +
    '<div class="bk-shop-checkout-summary-row" id="bk-shop-checkout-tax-row" style="display:none">' +
    '<span class="bk-shop-checkout-summary-label">Sales tax</span>' +
    '<span class="bk-shop-checkout-summary-amount" id="bk-shop-checkout-tax">$0.00</span>' +
    '</div>' +
    '<div class="bk-shop-checkout-summary-row">' +
    '<span class="bk-shop-checkout-summary-label">' +
    'Processing &amp; service fees' +
    '<span class="bk-shop-fee-info-wrap" id="bk-shop-fee-info-wrap">' +
    '<button type="button" class="bk-shop-fee-info" id="bk-shop-fee-info" aria-label="Processing fee details" aria-expanded="false" aria-controls="bk-shop-fee-tip">i</button>' +
    '<div class="bk-shop-fee-tip" id="bk-shop-fee-tip" role="tooltip"></div>' +
    '</span></span>' +
    '<span class="bk-shop-checkout-summary-amount bk-shop-checkout-summary-fee-pending" id="bk-shop-checkout-fee">Calculated at checkout</span>' +
    '</div>' +
    '<hr class="bk-shop-checkout-summary-divider">' +
    '<div class="bk-shop-checkout-summary-row bk-shop-checkout-summary-total" id="bk-shop-checkout-total-row" style="display:none">' +
    '<span class="bk-shop-checkout-summary-label">Total</span>' +
    '<span class="bk-shop-checkout-summary-amount" id="bk-shop-checkout-total">$0.00</span>' +
    '</div></div>' +
    '<div class="bk-shop-checkout-payment-section" id="bk-shop-checkout-payment-section">' +
    '<p class="bk-shop-checkout-payment-label">Payment</p>' +
    '<p class="bk-shop-payment-loading" id="bk-shop-payment-loading">Loading payment options…</p>' +
    '<div id="bk-shop-payment-element"></div>' +
    '<p class="bk-shop-checkout-stripe-note">Handled by Stripe — card details never touch our servers.</p>' +
    '</div>' +
    '<button type="submit" class="bk-shop-checkout-submit" id="bk-shop-checkout-submit" disabled>Pay $0.00</button>' +
    '<p class="bk-shop-checkout-secure">' +
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>' +
    ' Secure checkout by Stripe</p>' +
    '<p class="bk-shop-checkout-error" id="bk-shop-checkout-error" style="display:none"></p>' +
    '</form>' +
    '<div class="bk-shop-checkout-success" id="bk-shop-checkout-success" style="display:none">' +
    '<h2>Payment received</h2>' +
    '<p style="margin:0 0 16px">Thank you — here is your receipt.</p>' +
    '<div id="bk-shop-checkout-receipt"></div>' +
    '<p style="margin-top:20px"><a href="' + esc(tenantBaseUrl(tenant) + '/shop') + '">Back to shop</a></p>' +
    '</div></div></div>';
}

function shopStripePublishableKey(serverKey) {
  return (serverKey && String(serverKey).trim()) ||
    ((typeof window.stripePublishableKey === 'string' && window.stripePublishableKey.trim()) || '');
}

function shopPaymentElementAppearance(tenant) {
  var c = tenantColors(tenant);
  var isCharter = isCharterTheme(tenant);
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: c.accent,
      colorBackground: isCharter ? (c.card || c.bg || '#ffffff') : '#ffffff',
      colorText: isCharter ? (c.fg || '#111111') : '#111111',
      colorDanger: '#df1b41',
      borderRadius: isCharter ? '6px' : '10px',
      fontFamily: isCharter
        ? 'Inter, system-ui, sans-serif'
        : 'var(--font-display), system-ui, sans-serif',
    },
  };
}

function renderShopCheckoutReceipt(receipt) {
  if (!receipt) return '';
  var lines = Array.isArray(receipt.lineItems) ? receipt.lineItems : [];
  var linesHtml = lines.map(function(line) {
    var qty = Math.max(1, line.qty || 1);
    var name = esc(line.name || 'Item');
    var lineTotal = formatReceiptCents(line.lineTotalCents);
    return '<div class="bk-shop-receipt-line">' +
      '<div class="bk-shop-receipt-line-name">' + name +
      '<span class="bk-shop-receipt-line-qty">Qty ' + qty + '</span></div>' +
      '<div class="bk-shop-receipt-line-amount">' + lineTotal + '</div>' +
      '</div>';
  }).join('');
  if (!linesHtml) {
    linesHtml = '<div class="bk-shop-receipt-line"><div class="bk-shop-receipt-line-name">Order</div>' +
      '<div class="bk-shop-receipt-line-amount">' + formatReceiptCents(receipt.totalCents) + '</div></div>';
  }
  var feeRow = '';
  if ((receipt.shippingCents || 0) > 0) {
    feeRow += '<div class="bk-shop-receipt-total-row">' +
      '<span>Shipping</span>' +
      '<span>' + formatReceiptCents(receipt.shippingCents) + '</span></div>';
  }
  if ((receipt.taxCents || 0) > 0) {
    feeRow += '<div class="bk-shop-receipt-total-row">' +
      '<span>Sales tax</span>' +
      '<span>' + formatReceiptCents(receipt.taxCents) + '</span></div>';
  }
  if ((receipt.surchargeCents || 0) > 0) {
    feeRow += '<div class="bk-shop-receipt-total-row">' +
      '<span>Processing &amp; service fees</span>' +
      '<span>' + formatReceiptCents(receipt.surchargeCents) + '</span></div>';
  }
  var emailNote = receipt.customerEmail
    ? '<p class="bk-shop-receipt-meta" style="margin-top:10px">A copy was sent to ' + esc(receipt.customerEmail) + '.</p>'
    : '';
  var paidLabel = formatReceiptDate(receipt.paidAt);
  return '<div class="bk-shop-receipt" id="bk-shop-receipt-print">' +
    '<div class="bk-shop-receipt-head">' +
    '<p class="bk-shop-receipt-business">' + esc(receipt.businessName || 'Receipt') + '</p>' +
    '<p class="bk-shop-receipt-meta">Order #' + esc((receipt.orderId || '').slice(-8).toUpperCase()) +
    (paidLabel ? ' · ' + esc(paidLabel) : '') + '</p>' +
    '<p class="bk-shop-receipt-meta">' + esc(receipt.customerName || '') + '</p>' +
    '</div>' +
    '<div class="bk-shop-receipt-lines">' + linesHtml + '</div>' +
    '<div class="bk-shop-receipt-totals">' +
    '<div class="bk-shop-receipt-total-row"><span>Subtotal</span><span>' + formatReceiptCents(receipt.subtotalCents) + '</span></div>' +
    feeRow +
    '<div class="bk-shop-receipt-total-row bk-shop-receipt-grand"><span>Total paid</span><span>' +
    formatReceiptCents(receipt.totalCents) + '</span></div>' +
    '</div>' +
    emailNote +
    '<div class="bk-shop-receipt-actions">' +
    '<button type="button" class="bk-shop-receipt-print" onclick="window.print()">Print receipt</button>' +
    '</div></div>';
}

function showShopCheckoutSuccess(tenant, receipt) {
  var form = document.getElementById('bk-shop-checkout-form');
  var headEl = document.querySelector('.bk-shop-checkout-head');
  var successEl = document.getElementById('bk-shop-checkout-success');
  var receiptEl = document.getElementById('bk-shop-checkout-receipt');
  if (form) form.style.display = 'none';
  if (headEl) headEl.style.display = 'none';
  if (receiptEl) receiptEl.innerHTML = renderShopCheckoutReceipt(receipt);
  if (successEl) successEl.style.display = 'block';
  writeShopCart(tenant.id, { lines: [] });
  var navCount = document.getElementById('bk-shop-nav-count');
  if (navCount) navCount.style.display = 'none';
  window.__bkShopCheckoutStripe = null;
  try { sessionStorage.removeItem('bkShopCheckoutOrderId'); } catch (e) { /* ignore */ }
}

function finalizeShopCheckoutPayment(tenant, orderId, paymentIntentId) {
  return ensureAnonymousAuth().then(function() {
    return functions.httpsCallable('finalizeShopOrderPayment')({
      tenantSlug: tenant.slug,
      orderId: orderId,
      paymentIntentId: paymentIntentId
    });
  }).then(function(res) {
    var data = (res && res.data) || {};
    showShopCheckoutSuccess(tenant, data.receipt || null);
  });
}

function handleShopCheckoutReturn(tenant) {
  try {
    var params = new URLSearchParams(location.search || '');
    var redirectStatus = (params.get('redirect_status') || '').toLowerCase();
    var paymentIntentId = (params.get('payment_intent') || '').trim();
    if (!paymentIntentId || redirectStatus !== 'succeeded') return Promise.resolve(false);
    var orderId = (params.get('order_id') || sessionStorage.getItem('bkShopCheckoutOrderId') || '').trim();
    if (!orderId) return Promise.resolve(false);
    return finalizeShopCheckoutPayment(tenant, orderId, paymentIntentId).then(function() {
      if (window.history && window.history.replaceState) {
        window.history.replaceState({}, '', tenantBaseUrl(tenant) + '/shop/checkout');
      }
      return true;
    }).catch(function(err) {
      var errorEl = document.getElementById('bk-shop-checkout-error');
      if (errorEl) {
        errorEl.textContent = formatFirebaseHttpsError(err);
        errorEl.style.display = 'block';
      }
      return false;
    });
  } catch (e) {
    return Promise.resolve(false);
  }
}

function webShopCheckoutShell(tenant, wrapClass, navHtml, footerHtml, contentShellClass, surfaceKey) {
  var shellClass = contentShellClass || 'luxe-shop-page-shell';
  var extra = surfaceKey
    ? (' data-bk-color-surface="page"' +
      bladeBkSurfaceKeyAttr(tenant, surfaceKey) +
      luxeBkSurfaceKeyAttr(tenant, surfaceKey) +
      ' data-bk-band-tappable')
    : '';
  return '<div class="' + wrapClass + '">' + navHtml +
    '<div class="' + shellClass + '"' + extra + ' style="padding-top:32px">' + shopCheckoutInnerHtml(tenant) + '</div>' +
    (footerHtml || '') + tattooSidebarShellHtml(tenant) + '</div>';
}

function bindShopCheckoutPage(tenant) {
  bindShopPage(tenant);
  var form = document.getElementById('bk-shop-checkout-form');
  var errorEl = document.getElementById('bk-shop-checkout-error');
  var submitBtn = document.getElementById('bk-shop-checkout-submit');
  var subtitleEl = document.getElementById('bk-shop-checkout-subtitle');
  var emptyEl = document.getElementById('bk-shop-checkout-empty');
  var paymentLoading = document.getElementById('bk-shop-payment-loading');
  var noteToggle = document.getElementById('bk-shop-checkout-note-toggle');
  var notesWrap = document.getElementById('bk-shop-checkout-notes-wrap');
  if (!form) return;

  var prepareTimer = null;
  var preparing = false;
  var lastPrepareKey = '';
  var fulfillmentMethod = (tenant.shopPickupEnabled !== false) ? 'pickup' : (tenant.shopShippingEnabled ? 'shipping' : 'pickup');
  var selectedRate = null;
  var shippoShipmentId = null;
  var lastRatesById = {};

  function gatherContact() {
    var name = ((form.querySelector('[name="name"]') || {}).value || '').trim();
    var email = ((form.querySelector('[name="email"]') || {}).value || '').trim().toLowerCase();
    var phone = ((form.querySelector('[name="phone"]') || {}).value || '').trim();
    var notesField = form.querySelector('[name="notes"]');
    var notesExtra = notesField ? String(notesField.value || '').trim() : '';
    var cart = readShopCart(tenant.id);
    var cartNotes = formatShopCartNotes(cart);
    var notes = [cartNotes, notesExtra].filter(Boolean).join('\n\n');
    return { name: name, email: email, phone: phone, notes: notes, cart: cart };
  }

  function gatherShipAddress(contact) {
    return {
      name: contact.name || 'Customer',
      email: contact.email || '',
      phone: contact.phone || '',
      street1: ((document.getElementById('bk-shop-ship-street') || {}).value || '').trim(),
      street2: ((document.getElementById('bk-shop-ship-street2') || {}).value || '').trim(),
      city: ((document.getElementById('bk-shop-ship-city') || {}).value || '').trim(),
      state: ((document.getElementById('bk-shop-ship-state') || {}).value || '').trim().toUpperCase(),
      zip: ((document.getElementById('bk-shop-ship-zip') || {}).value || '').trim(),
      country: 'US',
    };
  }

  function shipAddressReady(addr) {
    return !!(addr.street1 && addr.city && addr.state && addr.zip);
  }

  function contactValid(contact) {
    return !!(contact.name && contact.email && contact.email.indexOf('@') > 0);
  }

  function cartPrepareKey(cart) {
    if (!cart || !cart.lines || !cart.lines.length) return '';
    var lines = cart.lines.map(function(L) {
      return (L.productId || '') + ':' + (L.qty || 1);
    }).join('|');
    var ratePart = fulfillmentMethod === 'shipping' && selectedRate
      ? (selectedRate.objectId + ':' + selectedRate.amountCents)
      : fulfillmentMethod;
    return lines + '|' + ratePart;
  }

  function setFulfillment(method) {
    fulfillmentMethod = method === 'shipping' ? 'shipping' : 'pickup';
    selectedRate = null;
    shippoShipmentId = null;
    [].forEach.call(document.querySelectorAll('[data-fulfillment]'), function(btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-fulfillment') === fulfillmentMethod ? 'true' : 'false');
    });
    var shipFields = document.getElementById('bk-shop-ship-fields');
    var pickupAddr = document.getElementById('bk-shop-pickup-address');
    if (shipFields) shipFields.hidden = fulfillmentMethod !== 'shipping';
    if (pickupAddr) pickupAddr.style.display = fulfillmentMethod === 'pickup' ? '' : 'none';
    var ratesEl = document.getElementById('bk-shop-rates');
    var ratesStatus = document.getElementById('bk-shop-rates-status');
    if (ratesEl) ratesEl.innerHTML = '';
    if (ratesStatus) ratesStatus.textContent = '';
    clearPaymentState();
    lastPrepareKey = '';
    updateCheckoutChrome();
    if (fulfillmentMethod === 'pickup') schedulePreparePayment(true);
  }

  function renderRates(rates) {
    var ratesEl = document.getElementById('bk-shop-rates');
    if (!ratesEl) return;
    ratesEl.innerHTML = rates.map(function(r) {
      var label = esc((r.provider || '') + (r.service ? (' · ' + r.service) : ''));
      var metaParts = [];
      if (r.durationTerms) metaParts.push(String(r.durationTerms).trim());
      if (r.estimatedDays != null) {
        metaParts.push('~' + r.estimatedDays + ' day' + (r.estimatedDays === 1 ? '' : 's'));
      }
      var meta = metaParts.length
        ? '<span class="bk-shop-checkout-rate-meta">' + esc(metaParts.join(' · ')) + '</span>'
        : '';
      return '<button type="button" class="bk-shop-checkout-rate" data-rate-id="' + esc(r.objectId) + '" aria-pressed="false">' +
        '<span class="bk-shop-checkout-rate-copy"><strong>' + label + '</strong>' + meta + '</span>' +
        '<strong>' + formatMoney(r.amountCents / 100) + '</strong></button>';
    }).join('');
  }

  function fetchShippingRates() {
    var contact = gatherContact();
    var addr = gatherShipAddress(contact);
    var statusEl = document.getElementById('bk-shop-rates-status');
    if (!shipAddressReady(addr)) {
      if (statusEl) statusEl.textContent = 'Enter a full shipping address first.';
      return;
    }
    if (!contact.cart.lines.length) return;
    if (statusEl) statusEl.textContent = 'Getting rates…';
    selectedRate = null;
    ensureAnonymousAuth()
      .then(function() {
        return functions.httpsCallable('getShopShippingRates')({
          tenantSlug: tenant.slug,
          customerName: contact.name || '',
          lineItems: contact.cart.lines.map(function(L) {
            return { productId: L.productId, name: L.name || '', qty: L.qty || 1 };
          }),
          addressTo: addr,
        });
      })
      .then(function(res) {
        var data = (res && res.data) || {};
        var rates = Array.isArray(data.rates) ? data.rates : [];
        shippoShipmentId = data.shipmentId || null;
        lastRatesById = {};
        rates.forEach(function(r) { if (r.objectId) lastRatesById[r.objectId] = r; });
        if (!rates.length) {
          if (statusEl) statusEl.textContent = 'No rates available for this address.';
          return;
        }
        if (statusEl) statusEl.textContent = 'Select a rate to continue.';
        renderRates(rates);
      })
      .catch(function(err) {
        if (statusEl) statusEl.textContent = formatFirebaseHttpsError(err);
      });
  }

  function updateCheckoutChrome() {
    var contact = gatherContact();
    var cart = contact.cart;
    if (subtitleEl) {
      subtitleEl.textContent = shopCheckoutSubtitleLine(tenant);
    }
    if (!cart.lines.length) {
      if (emptyEl) emptyEl.style.display = 'block';
      form.style.display = 'none';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    form.style.display = '';
    var subtotal = shopCartSubtotal(cart);
    var stripeState = window.__bkShopCheckoutStripe;
    var contactOk = contactValid(contact);
    updateShopCheckoutSummary(cart, stripeState, contactOk, preparing);
    if (submitBtn) {
      var payAmount = stripeState && stripeState.totalCents
        ? stripeState.totalCents / 100
        : subtotal;
      submitBtn.textContent = 'Pay ' + formatMoney(payAmount);
      var shippingReady = fulfillmentMethod !== 'shipping' || !!(selectedRate && selectedRate.objectId);
      submitBtn.disabled = !contactOk || preparing || !shippingReady || !stripeState;
    }
  }

  function clearPaymentState() {
    var stripeState = window.__bkShopCheckoutStripe;
    if (stripeState && stripeState.paymentElement) {
      try { stripeState.paymentElement.unmount(); } catch (e) { /* ignore */ }
    }
    window.__bkShopCheckoutStripe = null;
    lastPrepareKey = '';
    var mountEl = document.getElementById('bk-shop-payment-element');
    if (mountEl) mountEl.innerHTML = '';
    if (paymentLoading) {
      paymentLoading.style.display = '';
      paymentLoading.textContent = 'Loading payment options…';
    }
    updateCheckoutChrome();
  }

  function mountShopPaymentElement(checkoutData) {
    var pk = shopStripePublishableKey(checkoutData.publishableKey);
    if (!pk) throw new Error('Stripe publishable key is missing. Configure STRIPE_PUBLISHABLE_KEY on Cloud Functions.');
    if (typeof Stripe !== 'function') throw new Error('Stripe.js did not load.');
    var stripe = Stripe(pk, checkoutStripeOptions(checkoutData.stripeAccountId));
    var elements = stripe.elements({
      clientSecret: checkoutData.clientSecret,
      appearance: shopPaymentElementAppearance(tenant),
    });
    var mountEl = document.getElementById('bk-shop-payment-element');
    if (!mountEl) throw new Error('Payment form is unavailable.');
    mountEl.innerHTML = '';
    var paymentElement = elements.create('payment', { layout: 'tabs' });
    paymentElement.mount('#bk-shop-payment-element');
    window.__bkShopCheckoutStripe = {
      stripe: stripe,
      elements: elements,
      paymentElement: paymentElement,
      orderId: checkoutData.orderId,
      paymentIntentId: checkoutData.paymentIntentId,
      subtotalCents: checkoutData.subtotalCents,
      shippingCents: checkoutData.shippingCents || 0,
      taxCents: checkoutData.taxCents || 0,
      surchargeCents: checkoutData.surchargeCents || 0,
      platformFeeCents: checkoutData.platformFeeCents || 0,
      totalCents: checkoutData.totalCents,
      fulfillmentMethod: checkoutData.fulfillmentMethod || 'pickup',
    };
    if (paymentLoading) paymentLoading.style.display = 'none';
    var shopReprice = bindCheckoutMethodReprice({
      tenantSlug: tenant.slug,
      paymentIntentId: checkoutData.paymentIntentId,
      paymentElement: paymentElement,
      elements: elements,
      stripe: stripe,
      onPriced: function(data) {
        var state = window.__bkShopCheckoutStripe;
        if (!state) return;
        state.surchargeCents = data.surchargeCents;
        state.totalCents = data.totalCents;
        state.platformFeeCents = data.platformFeeCents || 0;
        state.rateLabel = data.rateLabel || '';
        state.method = data.method || 'card';
        updateCheckoutChrome();
      },
      onError: function(err) {
        if (errorEl) {
          errorEl.textContent = formatFirebaseHttpsError(err);
          errorEl.style.display = 'block';
        }
      },
      onNotice: function(msg) {
        if (!errorEl) return;
        errorEl.textContent = msg || '';
        errorEl.style.display = msg ? 'block' : 'none';
      }
    });
    window.__bkShopCheckoutStripe.prepareConfirm = shopReprice.prepareConfirm;
    updateCheckoutChrome();
  }

  function prepareCheckoutPayment(force) {
    var contact = gatherContact();
    if (!contact.cart.lines.length) return Promise.resolve(false);
    if (fulfillmentMethod === 'shipping' && !(selectedRate && selectedRate.objectId)) {
      if (paymentLoading) {
        paymentLoading.style.display = '';
        paymentLoading.textContent = 'Select a shipping rate to continue.';
      }
      return Promise.resolve(false);
    }
    var key = cartPrepareKey(contact.cart);
    if (!force && window.__bkShopCheckoutStripe && lastPrepareKey === key) {
      return Promise.resolve(true);
    }
    if (preparing) return Promise.resolve(false);
    preparing = true;
    updateCheckoutChrome();
    if (paymentLoading) {
      paymentLoading.style.display = '';
      paymentLoading.textContent = 'Loading payment options…';
    }
    if (errorEl) errorEl.style.display = 'none';
    var payload = {
      tenantSlug: tenant.slug,
      customerName: contactValid(contact) ? contact.name : '',
      customerEmail: contactValid(contact) ? contact.email : '',
      customerPhone: contact.phone || null,
      notes: contact.notes || null,
      fulfillmentMethod: fulfillmentMethod,
      lineItems: contact.cart.lines.map(function(L) {
        return { productId: L.productId, name: L.name || '', qty: L.qty || 1 };
      })
    };
    if (fulfillmentMethod === 'shipping' && selectedRate) {
      payload.shippoRateId = selectedRate.objectId;
      payload.shippoShipmentId = shippoShipmentId || null;
      payload.shippingAddress = gatherShipAddress(contact);
    }
    return ensureAnonymousAuth()
      .then(function() {
        var stripeReady = (window.BKSitePerf && window.BKSitePerf.ensureStripe)
          ? window.BKSitePerf.ensureStripe()
          : Promise.resolve();
        return stripeReady.then(function() {
          return functions.httpsCallable('createShopCheckoutPayment')(payload);
        });
      })
      .then(function(res) {
        var data = (res && res.data) || {};
        if (!data.clientSecret || !data.stripeAccountId) {
          throw new Error('Could not start payment. Please try again.');
        }
        try { sessionStorage.setItem('bkShopCheckoutOrderId', data.orderId || ''); } catch (storageErr) { /* ignore */ }
        if (window.__bkShopCheckoutStripe) clearPaymentState();
        mountShopPaymentElement(data);
        lastPrepareKey = key;
        return true;
      })
      .catch(function(err) {
        if (errorEl) {
          errorEl.textContent = formatFirebaseHttpsError(err);
          errorEl.style.display = 'block';
        }
        if (paymentLoading) {
          paymentLoading.style.display = '';
          paymentLoading.textContent = 'Payment options could not be loaded.';
        }
        return false;
      })
      .finally(function() {
        preparing = false;
        updateCheckoutChrome();
      });
  }

  function schedulePreparePayment(force) {
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(function() { prepareCheckoutPayment(!!force); }, force ? 0 : 500);
  }

  window.__bkShopCheckoutRefresh = updateCheckoutChrome;

  handleShopCheckoutReturn(tenant).then(function(handled) {
    if (!handled) updateCheckoutChrome();
  });

  if (noteToggle && notesWrap) {
    noteToggle.addEventListener('click', function(e) {
      e.preventDefault();
      notesWrap.hidden = !notesWrap.hidden;
      noteToggle.textContent = notesWrap.hidden ? '+ Add a note' : '− Hide note';
    });
  }

  form.addEventListener('click', function(ev) {
    var fulfillBtn = ev.target && ev.target.closest && ev.target.closest('[data-fulfillment]');
    if (fulfillBtn) {
      ev.preventDefault();
      setFulfillment(fulfillBtn.getAttribute('data-fulfillment'));
      return;
    }
    var rateBtn = ev.target && ev.target.closest && ev.target.closest('[data-rate-id]');
    if (rateBtn) {
      ev.preventDefault();
      var rid = rateBtn.getAttribute('data-rate-id');
      [].forEach.call(document.querySelectorAll('[data-rate-id]'), function(b) {
        b.setAttribute('aria-pressed', b === rateBtn ? 'true' : 'false');
      });
      selectedRate = lastRatesById[rid] || { objectId: rid, amountCents: 0 };
      schedulePreparePayment(true);
      return;
    }
    if (ev.target && ev.target.id === 'bk-shop-get-rates') {
      ev.preventDefault();
      fetchShippingRates();
    }
  });

  ['name', 'email', 'phone'].forEach(function(fieldName) {
    var el = form.querySelector('[name="' + fieldName + '"]');
    if (!el) return;
    el.addEventListener('input', function() {
      updateCheckoutChrome();
    });
  });

  if (form.dataset.bkCheckoutBound) {
    updateCheckoutChrome();
    if (readShopCart(tenant.id).lines.length) schedulePreparePayment(true);
    return;
  }
  form.dataset.bkCheckoutBound = '1';

  var feeInfoWrap = document.getElementById('bk-shop-fee-info-wrap');
  var feeInfoBtn = document.getElementById('bk-shop-fee-info');
  if (feeInfoBtn && feeInfoWrap) {
    feeInfoBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      var open = feeInfoWrap.classList.toggle('bk-shop-fee-tip-open');
      feeInfoBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', function(e) {
      if (!feeInfoWrap.contains(e.target)) {
        feeInfoWrap.classList.remove('bk-shop-fee-tip-open');
        feeInfoBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function syncShopCheckoutContact(contact) {
    var stripeState = window.__bkShopCheckoutStripe;
    if (!stripeState || !stripeState.orderId) {
      return Promise.reject(new Error('Payment is not ready yet.'));
    }
    return ensureAnonymousAuth().then(function() {
      return functions.httpsCallable('updateShopCheckoutContact')({
        tenantSlug: tenant.slug,
        orderId: stripeState.orderId,
        customerName: contact.name,
        customerEmail: contact.email,
        customerPhone: contact.phone || null,
        notes: contact.notes || null,
      });
    });
  }

  form.addEventListener('submit', function(ev) {
    ev.preventDefault();
    var contact = gatherContact();
    if (!contact.cart.lines.length) return;
    if (!contactValid(contact)) {
      if (errorEl) {
        errorEl.textContent = 'Name and email are required.';
        errorEl.style.display = 'block';
      }
      return;
    }
    if (errorEl) errorEl.style.display = 'none';

    var runPay = function() {
      var stripeState = window.__bkShopCheckoutStripe;
      if (!stripeState) return Promise.resolve(false);
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Processing…';
      }
      var returnUrl = tenantBaseUrl(tenant) + '/shop/checkout?order_id=' +
        encodeURIComponent(stripeState.orderId || '');
      return confirmCheckoutPayment(
        stripeState.prepareConfirm,
        stripeState.stripe,
        stripeState.elements,
        {
          return_url: returnUrl,
          payment_method_data: {
            billing_details: {
              name: contact.name,
              email: contact.email,
              phone: contact.phone || undefined,
            },
          },
        },
        function() { return syncShopCheckoutContact(contact); }
      ).then(function(result) {
        if (result.error) throw result.error;
        return finalizeShopCheckoutPayment(
          tenant,
          stripeState.orderId,
          stripeState.paymentIntentId
        );
      });
    };

    if (window.__bkShopCheckoutStripe) {
      runPay().catch(function(err) {
        if (errorEl) {
          errorEl.textContent = (err && err.message) ? err.message : 'Payment could not be completed.';
          errorEl.style.display = 'block';
        }
        updateCheckoutChrome();
      });
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Preparing payment…';
    }
    prepareCheckoutPayment(true).then(function(ok) {
      if (!ok) {
        updateCheckoutChrome();
        return;
      }
      return runPay();
    }).catch(function(err) {
      if (errorEl) {
        errorEl.textContent = formatFirebaseHttpsError(err);
        errorEl.style.display = 'block';
      }
      updateCheckoutChrome();
    });
  });

  updateCheckoutChrome();
  if (readShopCart(tenant.id).lines.length) schedulePreparePayment(true);
}

function bindShopPage(tenant) {
  var root = document.getElementById('root');
  if (!root) return;
  if (!document.getElementById('bk-shop-chrome')) {
    root.insertAdjacentHTML('beforeend', shopChromeHtml());
  } else if (!document.getElementById('bk-shop-modal-media')) {
    // Upgrade older chrome (pre–product detail layout) without a full page reload.
    var oldModal = document.getElementById('bk-shop-modal');
    if (oldModal) {
      var tmp = document.createElement('div');
      tmp.innerHTML = shopChromeHtml();
      var freshModal = tmp.querySelector('#bk-shop-modal');
      if (freshModal) oldModal.replaceWith(freshModal);
    }
  }
  var modal = document.getElementById('bk-shop-modal');
  var drawer = document.getElementById('bk-shop-cart-drawer');
  var cartBtn = document.getElementById('bk-shop-nav-cart');
  if (!modal || !drawer || !cartBtn) return;
  bindClassicMobileCartPlacement(cartBtn);
  bindShopCartLineDelegate();
  bindShopChromeDelegate();
  window.__bkShopActiveTenant = tenant;
  renderShopCartDrawer(tenant.id);
  var checkoutBtn = document.getElementById('bk-shop-cart-checkout');
  if (checkoutBtn) checkoutBtn.disabled = !readShopCart(tenant.id).lines.length;

  if (!window.__bkShopProductDelegate) {
    window.__bkShopProductDelegate = true;
    document.addEventListener('click', function(ev) {
      var t = window.__bkShopActiveTenant;
      if (!t) return;
      var el = ev.target;
      if (!el || !el.closest) return;
      var btn = el.closest('.luxe-product-card--btn');
      if (!btn) return;
      var r = document.getElementById('root');
      if (!r || !r.contains(btn)) return;
      var pid = btn.getAttribute('data-product-id');
      if (!pid) return;
      var prod = findProductById(t, pid);
      if (!prod) return;
      ev.preventDefault();
      openShopProductModal(prod);
    });
  }
}

function loadProducts(tid) {
  return db.collection('tenants').doc(tid).collection('products').get()
    .then(function(snap){
      var products = snap.docs.filter(function(d){ return d.data().isActive !== false; }).map(function(d){
        var x = d.data();
        return {
          id: d.id,
          name: x.name || '',
          description: (x.description != null ? String(x.description) : '') || '',
          category: x.category || '',
          price: x.price || 0,
          salePrice: x.salePrice || null,
          imageUrl: x.imageUrl || '',
          sortOrder: typeof x.sortOrder === 'number' ? x.sortOrder : 999999
        };
      });
      // Order set in the web design editor; products never reordered keep the order they load in.
      return products.sort(function(a, b){ return a.sortOrder - b.sortOrder; });
    });
}
