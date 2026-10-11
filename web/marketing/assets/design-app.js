/**
 * Get Bookking desktop Design editor — preview, templates, photos, content.
 */
(function () {
  'use strict';

  firebase.initializeApp(window.firebaseConfig);
  var auth = firebase.auth();
  var db = firebase.firestore();
  var storage = firebase.storage();

  var TEMPLATES = [
    { family: 'classic',  name: 'Classic',   subtitle: 'Balanced portfolio with hero, gallery, and about',    tags: ['Hero', 'Featured', 'About', 'Gallery', 'Booking'],        s1: '#F5EDD8', s2: '#2C2018', thumb: 'assets/brand/previews/classic-thumb.jpg' },
    { family: 'luxe',     id: 'luxe-v1',     name: 'Luxe',     subtitle: 'Elegant cream palette, refined sections',               tags: ['Hero', 'Services', 'Gallery', 'Promo', 'Shop'],           s1: '#FFFDF9', s2: '#C9A96E', thumb: 'assets/brand/previews/luxe-thumb.jpg' },
    { family: 'blade',    id: 'blade-v1',    name: 'Blade',    subtitle: 'Dark luxury, gold accents',                             tags: ['Hero', 'Services', 'Gallery', 'Reviews', 'Shop'],         s1: '#1a1f28', s2: '#C9A96E', thumb: 'assets/brand/previews/blade-thumb.jpg' },
    { family: 'stonecut', id: 'stonecut-v1', name: 'Stonecut', subtitle: 'Moody editorial with bold contrast',                    tags: ['Hero', 'Artists', 'Portfolio', 'Process', 'Booking'],     s1: '#060604', s2: '#c0221a', thumb: 'assets/brand/previews/stonecut-thumb.jpg' },
    { family: 'studio12', id: 'studio-12-v1',name: 'Studio 12',subtitle: 'Ivory editorial, marquee, horizontal gallery',          tags: ['Hero', 'Marquee', 'Philosophy', 'Gallery', 'Booking'],    s1: '#faf7f2', s2: '#b08060', thumb: 'assets/brand/previews/studio12-thumb.jpg' },
    // Charter plan only — not shown to standard/team/studio subscriptions.
    { family: 'charter',  id: 'charter-v1',  name: 'Charter',  subtitle: 'Boat charter platform with trips, shop, and booking',   tags: ['Featured', 'Trips', 'Shop', 'How It Works', 'Booking'],   s1: '#0a1628', s2: '#C9A96E', thumb: 'assets/brand/previews/charter-thumb.jpg', charterOnly: true }
  ];

  var SURFACE_TO_FIELD = {
    page: 'backgroundColor',
    hero: 'backgroundColor',
    featured: 'featuredWorkBackgroundColor',
    gallery: 'galleryPageBackgroundColor',
    card: 'cardSurfaceColor',
    about: 'aboutSectionBackgroundColor',
    sidebar: 'sidebarBackgroundColor'
  };

  var FIELD_LABELS = {
    displayName: 'Website name',
    'wc.site.displayName': 'Website name',
    tagline: 'Tagline',
    aboutText: 'About',
    contactPhone: 'Phone',
    contactEmail: 'Email',
    contactAddress: 'Address',
    luxeHeroTagline: 'Hero tagline',
    bladeHeroTagline: 'Hero tagline',
    bladeHeroDescription: 'Hero description',
    heroTagline: 'Hero italic line',
    heroSubtitle: 'Hero subtitle',
    studio12HeroEyebrow: 'Hero eyebrow',
    studio12HeroLine1: 'Hero line 1',
    studio12HeroLine2: 'Hero line 2',
    classicAboutEyebrow: 'About eyebrow',
    classicAboutHeading: 'About heading',
    classicServicesEyebrow: 'Services eyebrow',
    classicServicesHeading: 'Services heading',
    classicFeaturedWorkEyebrow: 'Featured eyebrow',
    classicFeaturedWorkHeading: 'Featured heading',
    classicFeaturedWorkSub: 'Featured subcopy',
    luxePromoHeadline: 'Promo headline',
    luxeFeaturedWorkEyebrow: 'Featured eyebrow',
    luxeFeaturedWorkHeading: 'Featured heading',
    luxeHomeServicesEyebrow: 'Services eyebrow',
    luxeHomeServicesHeading: 'Services heading'
  };

  /** Tenant fields safe to write from website Design (not identity). */
  var SITE_TEXT_FIELDS = {
    tagline: 1,
    aboutText: 1,
    contactPhone: 1,
    contactEmail: 1,
    contactAddress: 1,
    contactAddressSuite: 1,
    luxeHeroTagline: 1,
    bladeHeroTagline: 1,
    bladeHeroDescription: 1,
    heroTagline: 1,
    heroSubtitle: 1,
    serviceArea: 1,
    classicAboutEyebrow: 1,
    classicAboutHeading: 1,
    classicServicesEyebrow: 1,
    classicServicesHeading: 1,
    classicFeaturedWorkEyebrow: 1,
    classicFeaturedWorkHeading: 1,
    classicFeaturedWorkSub: 1,
    classicFeaturedWorkEmpty: 1,
    classicStatYearsValue: 1,
    classicStatYearsLabel: 1,
    classicStatClientsValue: 1,
    classicStatClientsLabel: 1,
    classicStatRatedValue: 1,
    classicStatRatedLabel: 1,
    luxePromoHeadline: 1,
    luxeFeaturedWorkEyebrow: 1,
    luxeFeaturedWorkHeading: 1,
    luxeHomeServicesEyebrow: 1,
    luxeHomeServicesHeading: 1,
    studio12HeroEyebrow: 1,
    studio12HeroLine1: 1,
    studio12HeroLine2: 1,
    studio12BookCtaLine1: 1,
    studio12BookCtaItalic: 1,
    studio12BookCtaBody: 1,
    studio12PhilosophyHeadLine1: 1,
    studio12PhilosophyHeadLine2: 1,
    studio12PhilosophyHeadItalic: 1
  };

  var state = {
    user: null,
    tenantId: null,
    tenant: null,
    slug: '',
    siteUrl: '',
    previewUrl: '',
    path: '/',
    device: 'desktop',
    mode: 'preview',
    editMode: true,
    editBarX: null,
    editBarY: null,
    editBarCollapsed: false,
    editTool: null,
    paintHex: '#FFFFFF',
    panel: 'pages',
    dirty: false,
    pending: {},
    selected: null,
    bridgeReady: false,
    saving: false,
    uploadTarget: null,
    crop: null,
    previewTry: 0,
    previewWatch: null,
    applyingHistory: false,
    historyPast: [],
    historyFuture: [],
    historyBurstArmed: false,
    historyBurstTimer: null,
    confirmAction: null,
    returnPanel: 'pages',
    section: null,
    booking: {
      services: [],
      servicesError: '',
      serviceOpenId: null,
      fieldsOpen: false,
      labelTimer: null,
      serviceTimer: null
    }
  };

  var HISTORY_KEYS = [
    'displayName', 'tagline', 'aboutText', 'contactPhone', 'contactEmail', 'contactAddress', 'contactAddressSuite',
    'backgroundColor', 'textColor', 'cardSurfaceColor', 'primaryColor', 'primaryColorHover',
    'featuredWorkBackgroundColor', 'featuredWorkTextColor', 'galleryPageBackgroundColor', 'galleryPageTextColor',
    'aboutSectionBackgroundColor', 'aboutSectionTextColor',
    'sidebarBackgroundColor', 'sidebarTextColor', 'sidebarCloseIconColor',
    'sidebarIconColorHome', 'sidebarIconColorBooking',
    'showGalleryPage', 'showBookPage', 'showAboutPage', 'showTeamPage', 'shopEnabled',
    'siteAnnouncementEnabled', 'siteAnnouncementText', 'seoTitle', 'seoDescription',
    'webThemeId', 'webCopyOverrides', 'webSurfaceColors', 'webButtonColors', 'webTextColors',
    'bookingFormStyleId', 'formSchema', 'guidedStepTitles', 'guidedStepOrder', 'reviews',
    'webSectionLayouts',
    'heroImageUrl', 'heroImagePixelWidth', 'heroImagePixelHeight',
    'featuredWorkImages', 'galleryImages',
    'studio12PhilosophyImageUrl', 'studio12PhilosophyImagePixelWidth', 'studio12PhilosophyImagePixelHeight',
    'studio12BookCtaImageUrl', 'studio12BookCtaImagePixelWidth', 'studio12BookCtaImagePixelHeight'
  ];

  function classicThemeId(industry) {
    switch (String(industry || '')) {
      case 'hair': return 'hair-salon-v1';
      case 'barber': return 'barber-shop-v1';
      case 'tattoos': return 'tattoo-studio-v1';
      case 'nails': return 'nail-salon-v1';
      default: return 'custom-standard';
    }
  }

  function $(id) { return document.getElementById(id); }

  function showGate(id) {
    ['gateLoading', 'gateLogin', 'gateNoSite', 'designApp'].forEach(function (pid) {
      var el = $(pid);
      if (el) el.classList.toggle('hidden', pid !== id);
    });
  }

  function normalizeHex(value, fallback) {
    var raw = String(value || '').trim();
    if (!raw) return fallback || '#000000';
    if (raw.charAt(0) !== '#') raw = '#' + raw;
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
      raw = '#' + raw.charAt(1) + raw.charAt(1) + raw.charAt(2) + raw.charAt(2) + raw.charAt(3) + raw.charAt(3);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) return fallback || '#000000';
    return raw.toUpperCase();
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  }

  function siteUrlForTenant(tenant) {
    var slug = String((tenant && tenant.slug) || '').trim().toLowerCase();
    var custom = '';
    if (tenant && tenant.customDomainStatus === 'active') {
      custom = String(tenant.customDomain || tenant.customDomainHost || '')
        .trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/^www\./, '');
    }
    if (custom) return 'https://' + custom;
    if (!slug) return '';
    return 'https://' + slug + '.getbookking.com';
  }

  function isLocalDesignShell() {
    var host = (location.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1';
  }

  /** Booking emulator origins. Override with ?previewOrigin=http://127.0.0.1:5000 */
  function localBookingCandidates() {
    var params = new URLSearchParams(location.search);
    var override = String(params.get('previewOrigin') || '').trim().replace(/\/$/, '');
    if (override) return [override];
    var host = location.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost';
    var designPort = parseInt(location.port, 10) || 0;
    return [5000, 5002, 5003, 5001].filter(function (p) { return p !== designPort; })
      .map(function (p) { return 'http://' + host + ':' + p; });
  }

  function localBookingOrigin() {
    return localBookingCandidates()[0] || ('http://' + (location.hostname === '127.0.0.1' ? '127.0.0.1' : 'localhost') + ':5000');
  }

  function previewUrlForTenant(tenant) {
    var live = siteUrlForTenant(tenant);
    var slug = String((tenant && tenant.slug) || '').trim().toLowerCase();
    if (!isLocalDesignShell() || !slug) return live;
    return localBookingOrigin() + '/' + encodeURIComponent(slug);
  }

  function previewOrigin() {
    var base = state.previewUrl || state.siteUrl;
    if (!base) return '';
    try { return new URL(base).origin; } catch (e) { return ''; }
  }

  function visibilityParam() {
    var t = state.tenant || {};
    function bit(on) { return on ? '1' : '0'; }
    return '&bk_vis=' + [
      'gallery:' + bit(t.showGalleryPage !== false),
      'book:' + bit(t.showBookPage !== false),
      'about:' + bit(t.showAboutPage !== false),
      'team:' + bit(t.showTeamPage !== false),
      'shop:' + bit(!!t.shopEnabled)
    ].join(',');
  }

  function previewSrc() {
    var baseUrl = state.previewUrl || state.siteUrl;
    if (!baseUrl) return '';
    var base = baseUrl.replace(/\/$/, '');
    var path = state.path || '/';
    if (path.charAt(0) !== '/') path = '/' + path;
    var url = base + (path === '/' ? '/' : path);
    var join = url.indexOf('?') === -1 ? '?' : '&';
    var themeParam = '';
    if (state.tenant && state.tenant.webThemeId) {
      themeParam = '&bk_web_theme=' + encodeURIComponent(state.tenant.webThemeId);
    }
    return url + join + 'bk_design=1' + themeParam + visibilityParam() + '&_cb=' + Date.now();
  }

  function setStatus(text, tone) {
    var el = $('saveStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('is-dirty', 'is-ok', 'is-err');
    if (tone) el.classList.add(tone);
  }

  function markDirty() {
    state.dirty = true;
    var btn = $('saveBtn');
    if (btn) {
      btn.disabled = false;
      btn.classList.add('is-dirty');
    }
    setStatus('Unsaved', 'is-dirty');
  }

  function markClean() {
    state.dirty = false;
    state.pending = {};
    var btn = $('saveBtn');
    if (btn) {
      btn.disabled = true;
      btn.classList.remove('is-dirty');
    }
    setStatus('Saved', 'is-ok');
  }

  function cloneValue(value) {
    if (value == null) return value;
    if (typeof value === 'object') {
      try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
    }
    return value;
  }

  function snapshotTenant() {
    var snap = {};
    var t = state.tenant || {};
    HISTORY_KEYS.forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(t, k)) snap[k] = cloneValue(t[k]);
    });
    // Include any pending / quick-edit string fields currently on tenant
    Object.keys(t).forEach(function (k) {
      if (snap[k] !== undefined) return;
      if (FIELD_LABELS[k] || k.indexOf('wc.') === 0) snap[k] = cloneValue(t[k]);
    });
    Object.keys(state.pending || {}).forEach(function (k) {
      snap[k] = cloneValue(state.pending[k]);
    });
    return snap;
  }

  function updateHistoryButtons() {
    var undoBtn = $('undoBtn');
    var redoBtn = $('redoBtn');
    if (undoBtn) undoBtn.disabled = !state.historyPast.length || state.applyingHistory;
    if (redoBtn) redoBtn.disabled = !state.historyFuture.length || state.applyingHistory;
  }

  function pushHistory() {
    if (state.applyingHistory || !state.tenant) return;
    state.historyPast.push(snapshotTenant());
    if (state.historyPast.length > 40) state.historyPast.shift();
    state.historyFuture = [];
    updateHistoryButtons();
  }

  /** Coalesce rapid color-drag / typing into one undo step. */
  function noteHistoryBeforeEdit() {
    if (state.applyingHistory) return;
    if (!state.historyBurstArmed) {
      pushHistory();
      state.historyBurstArmed = true;
    }
    if (state.historyBurstTimer) clearTimeout(state.historyBurstTimer);
    state.historyBurstTimer = setTimeout(function () {
      state.historyBurstArmed = false;
      state.historyBurstTimer = null;
    }, 700);
  }

  function refreshAfterHistory() {
    fillBrandKit();
    fillContentForm();
    renderPhotos();
    renderTemplates();
    renderHealth();
    if (state.panel === 'booking') renderBookingPanel();
    pushLivePreview();
    // Template / image URL changes need a full reload
    loadPreview();
    updateHistoryButtons();
  }

  async function applySnapshot(snap) {
    if (!state.tenantId || !snap) return;
    state.applyingHistory = true;
    updateHistoryButtons();
    setStatus('Restoring…');
    try {
      var updates = {};
      Object.keys(snap).forEach(function (k) {
        updates[k] = cloneValue(snap[k]);
        state.tenant[k] = cloneValue(snap[k]);
      });
      // Clear pending — history restore is authoritative
      state.pending = {};
      if (Object.keys(updates).length) {
        await db.collection('tenants').doc(state.tenantId).update(updates);
      }
      markClean();
      setStatus('Restored', 'is-ok');
      refreshAfterHistory();
    } catch (err) {
      console.error(err);
      setStatus('Undo failed', 'is-err');
      alert((err && err.message) || 'Could not undo.');
    } finally {
      state.applyingHistory = false;
      state.historyBurstArmed = false;
      updateHistoryButtons();
    }
  }

  async function undoChange() {
    if (!state.historyPast.length || state.applyingHistory) return;
    var current = snapshotTenant();
    var prev = state.historyPast.pop();
    state.historyFuture.push(current);
    updateHistoryButtons();
    await applySnapshot(prev);
  }

  async function redoChange() {
    if (!state.historyFuture.length || state.applyingHistory) return;
    var current = snapshotTenant();
    var next = state.historyFuture.pop();
    state.historyPast.push(current);
    updateHistoryButtons();
    await applySnapshot(next);
  }

  function queueUpdate(map) {
    noteHistoryBeforeEdit();
    Object.keys(map).forEach(function (k) {
      state.pending[k] = map[k];
      state.tenant[k] = map[k];
    });
    markDirty();
    updateHistoryButtons();
  }

  function postToFrame(type, payload) {
    var frame = $('previewFrame');
    if (!frame || !frame.contentWindow) return;
    var origin = previewOrigin();
    if (!origin) return;
    frame.contentWindow.postMessage(
      { source: 'bk-design-shell', type: type, payload: payload || {} },
      origin
    );
  }

  function colorPatchFromTenant(t) {
    return {
      backgroundColor: t.backgroundColor,
      textColor: t.textColor,
      cardSurfaceColor: t.cardSurfaceColor,
      primaryColor: t.primaryColor,
      primaryColorHover: t.primaryColorHover || t.primaryColor,
      featuredWorkBackgroundColor: t.featuredWorkBackgroundColor,
      featuredWorkTextColor: t.featuredWorkTextColor,
      galleryPageBackgroundColor: t.galleryPageBackgroundColor,
      galleryPageTextColor: t.galleryPageTextColor,
      aboutSectionBackgroundColor: t.aboutSectionBackgroundColor,
      aboutSectionTextColor: t.aboutSectionTextColor,
      sidebarBackgroundColor: t.sidebarBackgroundColor,
      sidebarTextColor: t.sidebarTextColor,
      sidebarCloseIconColor: t.sidebarCloseIconColor,
      sidebarIconColorHome: t.sidebarIconColorHome,
      sidebarIconColorBooking: t.sidebarIconColorBooking,
      webThemeId: t.webThemeId,
      industry: t.industry,
      // Independent fills — must travel with every color-patch so keyed bands and CTAs stay correct.
      webSurfaceColors: t.webSurfaceColors,
      webButtonColors: t.webButtonColors,
      webTextColors: t.webTextColors,
      webTextFontSizes: t.webTextFontSizes
    };
  }

  function pushLivePreview() {
    postToFrame('color-patch', colorPatchFromTenant(state.tenant));
    // The preview loads layouts from publicSites, which can lag the tenant; send ours so it always matches.
    postToFrame('layouts', (state.tenant && state.tenant.webSectionLayouts) || {});
    postToFrame('announcement', {
      enabled: !!state.tenant.siteAnnouncementEnabled,
      text: state.tenant.siteAnnouncementText || ''
    });
    postToFrame('seo', {
      title: state.tenant.seoTitle || state.tenant.displayName || '',
      description: state.tenant.seoDescription || ''
    });
  }

  var PANEL_META = {
    pages: { title: 'Pages', meta: '6' },
    photos: { title: 'Photos', meta: 'Site' },
    style: { title: 'Style', meta: 'Brand' },
    content: { title: 'Copy', meta: 'Site' },
    booking: { title: 'Booking', meta: '' },
    section: { title: 'Section', meta: 'Card' },
    settings: { title: 'Settings', meta: '' }
  };

  var VIEWPORT_LABEL = {
    desktop: 'Desktop · 1440 px',
    tablet: 'Tablet · 834 px',
    mobile: 'Mobile · 390 px'
  };

  function setPanelHidden(hidden) {
    var body = document.querySelector('.design-body');
    if (body) body.classList.toggle('is-panel-hidden', !!hidden);
    var aside = document.querySelector('.design-panel');
    if (aside) aside.setAttribute('aria-hidden', hidden ? 'true' : 'false');
    if (!hidden) return;
    document.querySelectorAll('.design-icon[data-panel]').forEach(function (btn) {
      btn.classList.remove('is-active');
    });
  }

  function setPanel(panel) {
    if (!PANEL_META[panel]) panel = 'pages';
    if (panel !== 'section' && state.section) {
      state.section = null;
      postToFrame('clear-selection', {});
    }
    setPanelHidden(false);
    state.panel = panel;
    document.querySelectorAll('.design-icon[data-panel]').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-panel') === panel);
    });
    Object.keys(PANEL_META).forEach(function (name) {
      var el = $('panel' + name.charAt(0).toUpperCase() + name.slice(1));
      if (el) el.classList.toggle('hidden', name !== panel);
    });
    var meta = PANEL_META[panel];
    if ($('panelTitle')) $('panelTitle').textContent = meta.title;
    if ($('panelMeta')) $('panelMeta').textContent = meta.meta;
    if (panel === 'pages') applyPageListForPlan();
    if (panel === 'photos') renderPhotos();
    if (panel === 'content') fillContentForm();
    if (panel === 'booking') renderBookingPanel();
    if (panel === 'section' && state.section) {
      if ($('panelTitle')) $('panelTitle').textContent = state.section.label || 'Section';
      if ($('panelMeta')) $('panelMeta').textContent = 'Card';
    }
    if (panel !== 'style' && state.mode === 'templates') setMode('preview');
    // keep top tab strip in sync
    syncTopTabs('editor');
  }

  var LAYOUT_OPTIONS = {
    header: [
      { id: 'links', label: 'Name and links' },
      { id: 'center', label: 'Centered' },
      { id: 'book', label: 'Name and Book' }
    ],
    hero: [
      { id: 'split', label: 'Text left' },
      { id: 'splitFlip', label: 'Photo left' },
      { id: 'overlay', label: 'Text over photo' },
      { id: 'card', label: 'Text card on photo' },
      { id: 'stack', label: 'Stacked' },
      { id: 'text', label: 'Text only' }
    ],
    gallery: [
      { id: 'two', label: 'Two across' },
      { id: 'three', label: 'Three across' },
      { id: 'four', label: 'Four across' },
      { id: 'feature', label: 'Featured first' },
      { id: 'strip', label: 'Scrolling strip' }
    ],
    services: [
      { id: 'list', label: 'List' },
      { id: 'cards', label: 'Cards' }
    ],
    shop: [
      { id: 'two', label: 'Two across' },
      { id: 'three', label: 'Three across' },
      { id: 'cards', label: 'Four across', thumb: 'four' },
      { id: 'list', label: 'List' }
    ],
    about: [
      { id: 'split', label: 'Side by side' },
      { id: 'splitFlip', label: 'Side by side, flipped' },
      { id: 'stack', label: 'Stacked' }
    ],
    team: [
      { id: 'cards', label: 'Cards' },
      { id: 'list', label: 'List' }
    ],
    footer: [
      { id: 'center', label: 'Centered' },
      { id: 'split', label: 'Name and links' }
    ]
  };

  function layoutSlot(label) {
    if (label === 'Header') return 'header';
    if (label === 'Hero') return 'hero';
    if (label === 'Featured' || label === 'Gallery') return 'gallery';
    if (label === 'Services' || label === 'Service') return 'services';
    if (label === 'Shop' || label === 'Shop page') return 'shop';
    if (label === 'About') return 'about';
    if (label === 'Team') return 'team';
    if (label === 'Footer') return 'footer';
    return '';
  }

  function layoutSlotFor(payload) {
    var byLabel = layoutSlot(payload && payload.label);
    if (byLabel) return byLabel;
    var key = (payload && payload.surfaceKey) || '';
    var surface = (payload && payload.surface) || '';
    if (/\.nav$/.test(key)) return 'header';
    if (/\.hero$/.test(key) || surface === 'hero') return 'hero';
    if (/\.featured$/.test(key) || /gallery/i.test(key) || surface === 'gallery' || surface === 'featured') return 'gallery';
    if (/\.services$/.test(key) || /\.svcCard\./.test(key)) return 'services';
    if (/shop/i.test(key)) return 'shop';
    if (/\.about$/.test(key)) return 'about';
    if (/team/i.test(key)) return 'team';
    if (/\.footer$/.test(key) || key === 'luxe.legal') return 'footer';
    return '';
  }

  function layoutTheme(payload) {
    // Prefer the theme the preview actually rendered; webThemeId can be blank and resolved by industry.
    return (payload && payload.theme) || (state.tenant && state.tenant.webThemeId) || '';
  }

  // Sections whose template markup can't take these layouts (Studio 12's gallery is a scrolling strip).
  var LAYOUT_UNSUPPORTED = {
    'studio-12-v1': ['gallery']
  };
  // Single options that would look the same as another one on a template (Luxe's About has no photo to flip).
  var LAYOUT_OPTION_HIDDEN = {
    'luxe-v1': { about: ['splitFlip'] }
  };

  function layoutDefault(slot, payload) {
    var theme = layoutTheme(payload);
    var luxe = theme.indexOf('luxe') !== -1;
    var cardServices = theme === 'blade-v1' || theme === 'stonecut-v1' || theme === 'studio-12-v1';
    if (slot === 'hero') return luxe ? 'overlay' : (theme === 'studio-12-v1' ? 'splitFlip' : 'split');
    if (slot === 'gallery') return luxe ? 'four' : 'three';
    if (slot === 'shop' || slot === 'team') return 'cards';
    if (slot === 'services') return cardServices ? 'cards' : 'list';
    if (slot === 'about') return 'split';
    if (slot === 'header') return 'links';
    if (slot === 'footer') return theme === 'stonecut-v1' ? 'split' : 'center';
    return '';
  }

  function layoutPickerHtml(payload) {
    var slot = layoutSlotFor(payload);
    var options = slot && LAYOUT_OPTIONS[slot];
    if (!options) return '';
    var theme = layoutTheme(payload);
    if ((LAYOUT_UNSUPPORTED[theme] || []).indexOf(slot) !== -1) return '';
    var hiddenOptions = (LAYOUT_OPTION_HIDDEN[theme] || {})[slot] || [];
    options = options.filter(function (opt) { return hiddenOptions.indexOf(opt.id) === -1; });
    var saved = state.tenant && state.tenant.webSectionLayouts;
    var current = (saved && saved[slot]) || layoutDefault(slot, payload);
    var html = '<h2>Layout</h2><div class="design-layout-grid">';
    options.forEach(function (opt) {
      html += '<button type="button" class="design-layout-opt' + (opt.id === current ? ' is-on' : '') + '" data-layout-slot="' + slot + '" data-layout-value="' + opt.id + '">' +
        '<span class="design-layout-thumb design-layout-thumb--' + (opt.thumb || opt.id) + '" aria-hidden="true"></span>' +
        escHtml(opt.label) + '</button>';
    });
    return html + '</div>';
  }

  var ALIGN_SLOTS = ['hero', 'gallery', 'services', 'about', 'team', 'shop'];

  function savedLayouts() {
    return (state.tenant && state.tenant.webSectionLayouts) || {};
  }

  function segmentedHtml(attr, slot, options, current) {
    var html = '<div class="design-seg" role="radiogroup">';
    options.forEach(function (opt) {
      html += '<button type="button" role="radio" aria-checked="' + (opt.id === current) + '" class="design-seg-opt' +
        (opt.id === current ? ' is-on' : '') + '" ' + attr + '="' + opt.id + '" data-layout-slot="' + slot + '"' +
        (opt.title ? ' aria-label="' + opt.title + '" title="' + opt.title + '"' : '') + '>' + opt.label + '</button>';
    });
    return html + '</div>';
  }

  function alignControlHtml(payload) {
    var slot = layoutSlotFor(payload);
    if (ALIGN_SLOTS.indexOf(slot) === -1) return '';
    var current = savedLayouts()[slot + 'Align'] || payload.align || 'left';
    var icon = function (d) { return '<svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"><path d="' + d + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'; };
    return '<h2>Alignment</h2>' + segmentedHtml('data-align-value', slot, [
      { id: 'left', title: 'Align left', label: icon('M2 2h14M2 7h8M2 12h11') },
      { id: 'center', title: 'Align center', label: icon('M2 2h14M5 7h8M3.5 12h11') },
      { id: 'right', title: 'Align right', label: icon('M2 2h14M8 7h8M5 12h11') }
    ], current);
  }

  function renderSectionBody(payload) {
    var host = $('sectionBody');
    if (!host) return;
    // Text, photos, and colors are edited directly on the preview; this panel only arranges the section.
    var html = layoutPickerHtml(payload) + alignControlHtml(payload);
    if (payload.label === 'Booking form' || payload.label === 'Booking page') {
      html += '<button type="button" class="design-btn design-btn--ghost" id="sectionBookingBtn">Form, fields, and services</button>';
    }
    if (!html) html = '<p class="design-hint">This section has no layout options. Click text or photos in the preview to edit them.</p>';
    host.innerHTML = html;
    var panel = $('panelSection');
    if (panel) panel.scrollTop = 0;

    var bookingBtn = $('sectionBookingBtn');
    if (bookingBtn) {
      bookingBtn.addEventListener('click', function () { setPanel('booking'); });
    }
    host.querySelectorAll('[data-layout-value]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slot = btn.getAttribute('data-layout-slot');
        var value = btn.getAttribute('data-layout-value');
        if (!slot || !value) return;
        var map = Object.assign({}, savedLayouts());
        map[slot] = value;
        queueUpdate({ webSectionLayouts: map });
        postToFrame('layouts', map);
        host.querySelectorAll('[data-layout-value][data-layout-slot="' + slot + '"]').forEach(function (other) {
          other.classList.toggle('is-on', other === btn);
        });
      });
    });
    host.querySelectorAll('[data-align-value]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var slot = btn.getAttribute('data-layout-slot');
        var map = Object.assign({}, savedLayouts());
        map[slot + 'Align'] = btn.getAttribute('data-align-value');
        queueUpdate({ webSectionLayouts: map });
        postToFrame('layouts', map);
        host.querySelectorAll('[data-align-value]').forEach(function (other) {
          other.classList.toggle('is-on', other === btn);
          other.setAttribute('aria-checked', String(other === btn));
        });
      });
    });
  }

  function openSection(payload) {
    if (!payload || !state.tenant) return;
    if (state.panel !== 'section') state.returnPanel = state.panel || 'pages';
    state.section = payload;
    state.selected = {
      kind: 'color',
      surface: payload.surface || '',
      surfaceKey: payload.surfaceKey || '',
      key: 'color:' + (payload.surface || 'section')
    };
    setPanel('section');
    renderSectionBody(payload);
  }

  function syncTopTabs(activeTab) {
    document.querySelectorAll('.design-top-tab[data-tab]').forEach(function (b) {
      var isActive = b.getAttribute('data-tab') === activeTab;
      b.classList.toggle('is-active', isActive);
      b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  function setMode(mode) {
    state.mode = mode === 'templates' ? 'templates' : 'preview';
    var templates = state.mode === 'templates';
    if ($('workspacePreview')) $('workspacePreview').classList.toggle('hidden', templates);
    if ($('workspaceTemplates')) $('workspaceTemplates').classList.toggle('hidden', !templates);
    document.getElementById('designApp').classList.toggle('is-templates', templates);
    syncTopTabs(templates ? 'templates' : 'editor');
    if (templates) renderTemplates();
    syncEditBar();
  }

  function syncPagePath() {
    if ($('pagePath')) $('pagePath').textContent = state.path || '/';
  }

  function syncEditToggle() {
    var btn = $('editModeBtn');
    if (!btn) return;
    var on = !!state.editMode;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on
      ? 'Edit is on. Turn off to click through the site.'
      : 'Edit is off. Click through the site, then turn this on to edit.';
    syncEditBar();
  }

  function persistEditBar() {
    try {
      if (state.editBarX == null || state.editBarY == null) {
        localStorage.removeItem('bkDesignEditBarX');
        localStorage.removeItem('bkDesignEditBarY');
      } else {
        localStorage.setItem('bkDesignEditBarX', String(state.editBarX));
        localStorage.setItem('bkDesignEditBarY', String(state.editBarY));
      }
      localStorage.setItem('bkDesignEditBarCollapsed', state.editBarCollapsed ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  function loadEditBarPrefs() {
    try {
      var x = parseFloat(localStorage.getItem('bkDesignEditBarX'));
      var y = parseFloat(localStorage.getItem('bkDesignEditBarY'));
      if (isFinite(x) && isFinite(y)) {
        state.editBarX = x;
        state.editBarY = y;
      }
      state.editBarCollapsed = localStorage.getItem('bkDesignEditBarCollapsed') === '1';
    } catch (e) { /* ignore */ }
  }

  function clampEditBar(left, top) {
    var host = $('workspacePreview');
    var bar = $('editBar');
    if (!host || !bar) return { left: left, top: top };
    var margin = 8;
    var maxL = Math.max(margin, host.clientWidth - bar.offsetWidth - margin);
    var maxT = Math.max(margin, host.clientHeight - bar.offsetHeight - margin);
    return {
      left: Math.min(maxL, Math.max(margin, left)),
      top: Math.min(maxT, Math.max(margin, top))
    };
  }

  function applyEditBarPos() {
    var bar = $('editBar');
    var host = $('workspacePreview');
    if (!bar || !host || bar.hidden) return;
    var left;
    var top;
    if (state.editBarX == null || state.editBarY == null) {
      left = (host.clientWidth - bar.offsetWidth) / 2;
      top = host.clientHeight - bar.offsetHeight - 16;
    } else {
      left = state.editBarX * host.clientWidth;
      top = state.editBarY * host.clientHeight;
    }
    var pos = clampEditBar(left, top);
    bar.style.left = pos.left + 'px';
    bar.style.top = pos.top + 'px';
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    bar.style.transform = 'none';
  }

  function rememberEditBarPos() {
    var bar = $('editBar');
    var host = $('workspacePreview');
    if (!bar || !host || !host.clientWidth || !host.clientHeight) return;
    state.editBarX = parseFloat(bar.style.left) / host.clientWidth;
    state.editBarY = parseFloat(bar.style.top) / host.clientHeight;
  }

  function syncEditBar() {
    var bar = $('editBar');
    if (!bar) return;
    var show = !!state.editMode && state.mode !== 'templates';
    bar.hidden = !show;
    bar.classList.toggle('is-collapsed', !!state.editBarCollapsed);
    var chev = $('editBarChevron');
    if (chev) {
      chev.textContent = '^';
      chev.setAttribute('aria-expanded', state.editBarCollapsed ? 'false' : 'true');
      chev.setAttribute('aria-label', state.editBarCollapsed ? 'Open edit toolbar' : 'Collapse edit toolbar');
    }
    var text = $('editBarText');
    var color = $('editBarColor');
    var hex = $('editBarHex');
    var sel = state.selected;
    var textOn = !!(sel && sel.kind === 'text');
    var colorOn = !!(sel && sel.kind === 'color');
    if (text) {
      text.disabled = !textOn;
      text.placeholder = textOn ? 'Text' : 'Click text';
      if (!textOn) text.value = '';
      else if (document.activeElement !== text && $('inspectorFieldInput')) text.value = $('inspectorFieldInput').value;
    }
    var bgTool = state.editTool === 'background';
    if (color) color.disabled = !(colorOn || bgTool);
    if (hex) {
      hex.disabled = !(colorOn || bgTool);
      hex.placeholder = '#';
      if (!colorOn && !bgTool && document.activeElement !== hex) hex.value = '';
      if (bgTool && !colorOn && document.activeElement !== hex) hex.value = state.paintHex || '#FFFFFF';
    }
    if (colorOn && $('inspectorColorInput') && $('inspectorColorText')) {
      var shownHex = $('inspectorColorText').value || '';
      if (shownHex && bgTool) state.paintHex = shownHex;
      if (color && document.activeElement !== color) color.value = $('inspectorColorInput').value;
      if (hex && document.activeElement !== hex) hex.value = shownHex || state.paintHex || '';
    }
    var textToolBtn = $('editBarTextTool');
    var colorToolBtn = $('editBarColorTool');
    if (textToolBtn) {
      var textArmed = state.editTool === 'text';
      textToolBtn.classList.toggle('is-on', textArmed);
      textToolBtn.setAttribute('aria-pressed', textArmed ? 'true' : 'false');
    }
    if (colorToolBtn) {
      colorToolBtn.classList.toggle('is-on', bgTool);
      colorToolBtn.setAttribute('aria-pressed', bgTool ? 'true' : 'false');
    }
    var wheel = $('editBarWheel');
    if (wheel) {
      wheel.hidden = !bgTool;
      if (bgTool) drawEditWheel(wheel);
    }
    var seen = $('editBarSeen');
    if (seen && !bgTool) seen.textContent = '';
    var pointer = $('editPointer');
    if (pointer && !state.editTool) pointer.hidden = true;
    applyEditBarPos();
  }

  var editWheelDrawn = false;
  function hsvToRgb(h, s, v) {
    var c = v * s;
    var hh = ((h % 360) + 360) % 360 / 60;
    var x = c * (1 - Math.abs(hh % 2 - 1));
    var m = v - c;
    var r = 0;
    var g = 0;
    var b = 0;
    if (hh < 1) { r = c; g = x; }
    else if (hh < 2) { r = x; g = c; }
    else if (hh < 3) { g = c; b = x; }
    else if (hh < 4) { g = x; b = c; }
    else if (hh < 5) { r = x; b = c; }
    else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  function rgbToHex(r, g, b) {
    function part(n) {
      var s = n.toString(16);
      return s.length < 2 ? '0' + s : s;
    }
    return ('#' + part(r) + part(g) + part(b)).toUpperCase();
  }

  function drawEditWheel(canvas) {
    if (!canvas || editWheelDrawn) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    var w = canvas.width;
    var h = canvas.height;
    var cx = w / 2;
    var cy = h / 2;
    var radius = w / 2 - 1;
    var img = ctx.createImageData(w, h);
    var y;
    var x;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var dx = x - cx;
        var dy = y - cy;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var i = (y * w + x) * 4;
        if (dist > radius) {
          img.data[i + 3] = 0;
          continue;
        }
        var hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        var rgb = hsvToRgb(hue, dist / radius, 1);
        img.data[i] = rgb[0];
        img.data[i + 1] = rgb[1];
        img.data[i + 2] = rgb[2];
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    editWheelDrawn = true;
  }

  function wheelHexFromEvent(ev) {
    var canvas = $('editBarWheel');
    if (!canvas) return '';
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return '';
    var x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    var y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    var dx = x - canvas.width / 2;
    var dy = y - canvas.height / 2;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var radius = canvas.width / 2 - 1;
    if (dist > radius) return '';
    var hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    var rgb = hsvToRgb(hue, Math.min(1, dist / radius), 1);
    return rgbToHex(rgb[0], rgb[1], rgb[2]);
  }

  var paintSelection = function () {};

  function setPaintHex(hex, live) {
    hex = normalizeHex(hex, state.paintHex || '#FFFFFF');
    state.paintHex = hex;
    if ($('editBarColor')) $('editBarColor').value = hex;
    if ($('editBarHex') && document.activeElement !== $('editBarHex')) $('editBarHex').value = hex;
    var pointer = $('editPointer');
    if (pointer) pointer.style.setProperty('--drop', hex);
    if (live) paintSelection(hex);
  }

  function setEditTool(next) {
    if (!state.editMode) next = null;
    if (next !== 'text' && next !== 'background') next = null;
    state.editTool = state.editTool === next ? null : next;
    postToFrame('tool', { tool: state.editTool || '' });
    syncEditBar();
  }

  function moveEditPointer(ev) {
    var pointer = $('editPointer');
    if (!pointer) return;
    if (!state.editMode || (state.editTool !== 'text' && state.editTool !== 'background')) {
      pointer.hidden = true;
      return;
    }
    var frame = $('previewFrame');
    if (frame && (ev.target === frame || frame.contains(ev.target))) {
      pointer.hidden = true;
      return;
    }
    pointer.hidden = false;
    pointer.setAttribute('data-tool', state.editTool);
    pointer.style.left = ev.clientX + 'px';
    pointer.style.top = ev.clientY + 'px';
    var mark = $('editPointerMark');
    var label = $('editPointerHex');
    if (state.editTool === 'text') {
      if (mark) mark.textContent = 'T';
      if (label) label.textContent = '';
      return;
    }
    if (mark) mark.textContent = '';
    if (label) label.textContent = state.paintHex || '';
    pointer.style.setProperty('--drop', state.paintHex || '#FFFFFF');
  }

  function postEditMode() {
    if (!state.editMode) state.editTool = null;
    postToFrame(state.editMode ? 'enable' : 'disable');
    postToFrame('tool', { tool: state.editMode ? (state.editTool || '') : '' });
    pushLivePreview();
    syncEditBar();
  }

  function previewPathFromHref(href) {
    if (!href) return '';
    try {
      var url = new URL(href);
      var parts = (url.pathname || '/').split('/').filter(Boolean);
      var slug = String(state.slug || '').toLowerCase();
      if (slug && parts.length && parts[0].toLowerCase() === slug) parts.shift();
      var path = '/' + parts.join('/');
      if (path === '/home') path = '/';
      return path;
    } catch (e) {
      return '';
    }
  }

  function syncPathFromPreviewHref(href) {
    var path = previewPathFromHref(href);
    if (!path || path === state.path) return;
    state.path = path;
    document.querySelectorAll('.design-nav-btn[data-path]').forEach(function (b) {
      b.classList.toggle('is-active', (b.getAttribute('data-path') || '/') === path);
    });
    syncPagePath();
  }

  var DEVICE_WIDTH = { desktop: 1440, tablet: 834, mobile: 390 };

  // Render the preview at the device's real width and scale it down to fit, so the template's
  // breakpoints match the chosen device even when the side panel narrows the canvas.
  function fitPreviewFrame() {
    var shell = $('frameShell');
    var frame = $('previewFrame');
    var canvas = shell && shell.parentNode;
    if (!shell || !frame || !canvas) return 1;
    var width = DEVICE_WIDTH[state.device] || DEVICE_WIDTH.desktop;
    var avail = canvas.clientWidth - 48;
    if (avail <= 0) return 1;
    var border = shell.offsetWidth - shell.clientWidth;
    var scale = Math.min(1, (avail - border) / width);
    shell.style.width = Math.ceil(width * scale) + border + 'px';
    frame.style.width = width + 'px';
    frame.style.height = Math.ceil(shell.clientHeight / scale) + 'px';
    frame.style.transformOrigin = '0 0';
    frame.style.transform = scale < 1 ? 'scale(' + scale + ')' : '';
    return scale;
  }

  function syncViewportLabel() {
    var scale = fitPreviewFrame();
    if ($('viewportLabel')) {
      $('viewportLabel').textContent = (VIEWPORT_LABEL[state.device] || VIEWPORT_LABEL.desktop) +
        (scale < 1 ? ' · ' + Math.round(scale * 100) + '%' : '');
    }
  }

  function currentThemeFamily() {
    var id = String((state.tenant && state.tenant.webThemeId) || '');
    if (id === 'luxe-v1') return 'luxe';
    if (id === 'blade-v1') return 'blade';
    if (id === 'stonecut-v1') return 'stonecut';
    if (id === 'studio-12-v1') return 'studio12';
    return 'classic';
  }

  function isCharterTenant() {
    if (!state.tenant) return false;
    var plan = String(state.tenant.subscriptionPlan || '').toLowerCase();
    if (plan === 'charter' || plan === 'charters') return true;
    var theme = String(state.tenant.webThemeId || '').toLowerCase();
    if (theme === 'charter-v1') return true;
    return String(state.tenant.industry || '').toLowerCase() === 'charters';
  }

  function renderTemplates() {
    var active = currentThemeFamily();
    var grid = $('templateGrid');
    var isCharter = isCharterTenant();
    var visible = TEMPLATES.filter(function (t) {
      return isCharter ? !!t.charterOnly : !t.charterOnly;
    });
    grid.innerHTML = visible.map(function (t) {
      var tags = t.tags.map(function (x) { return '<span>' + x + '</span>'; }).join('');
      var preview = t.thumb
        ? '<img class="design-template-thumb" src="' + t.thumb + '" alt="" loading="lazy" />'
        : '<div class="design-template-swatch" style="--s1:' + t.s1 + ';--s2:' + t.s2 + '"><span></span><span></span></div>';
      return (
        '<button type="button" class="design-template-card' + (t.family === active ? ' is-active' : '') + '" data-family="' + t.family + '">' +
          preview +
          '<div class="design-template-body"><h3>' + t.name + '</h3><p>' + t.subtitle + '</p>' +
          '<div class="design-template-tags">' + tags + '</div></div></button>'
      );
    }).join('');
    grid.querySelectorAll('.design-template-card').forEach(function (card) {
      card.addEventListener('click', function () {
        applyTemplate(card.getAttribute('data-family'));
      });
    });
  }

  async function applyTemplate(family) {
    var meta = TEMPLATES.find(function (t) { return t.family === family; });
    if (!meta || !state.tenant) return;
    var themeId = meta.id || classicThemeId(state.tenant.industry);
    if (themeId === state.tenant.webThemeId) return;
    noteHistoryBeforeEdit();
    state.historyBurstArmed = false;
    setStatus('Applying…');
    try {
      await db.collection('tenants').doc(state.tenantId).update({ webThemeId: themeId });
      state.tenant.webThemeId = themeId;
      renderTemplates();
      if (state.panel === 'booking') renderBookingPanel();
      setStatus('Template updated', 'is-ok');
      setMode('preview');
      loadPreview();
      updateHistoryButtons();
    } catch (err) {
      console.error(err);
      setStatus('Template failed', 'is-err');
      alert((err && err.message) || 'Could not switch template.');
    }
  }

  function setPhotoEl(container, url, emptyText) {
    if (!container) return;
    if (url) {
      container.innerHTML = '<img src="' + url.replace(/"/g, '&quot;') + '" alt="" />';
    } else {
      container.innerHTML = '<span class="design-photo-empty">' + (emptyText || 'No photo') + '</span>';
    }
  }

  function renderPhotos() {
    var t = state.tenant;
    setPhotoEl($('heroPhotoPreview'), t.heroImageUrl, 'No hero photo yet');
    setPhotoEl($('philosophyPhotoPreview'), t.studio12PhilosophyImageUrl, 'Philosophy');
    setPhotoEl($('bookCtaPhotoPreview'), t.studio12BookCtaImageUrl, 'Book CTA');
    $('studio12PhotoBlock').classList.toggle('hidden', currentThemeFamily() !== 'studio12');

    var featured = Array.isArray(t.featuredWorkImages) ? t.featuredWorkImages.slice() : [];
    $('featuredPhotoGrid').innerHTML = featured.map(function (url, i) {
      return '<div class="design-photo-tile" data-kind="featured" data-index="' + i + '">' +
        '<img src="' + String(url).replace(/"/g, '&quot;') + '" alt="" />' +
        '<button type="button" class="design-photo-remove" aria-label="Remove">&times;</button></div>';
    }).join('');

    var gallery = Array.isArray(t.galleryImages) ? t.galleryImages.slice() : [];
    $('galleryPhotoGrid').innerHTML = gallery.map(function (url, i) {
      return '<div class="design-photo-tile" data-kind="gallery" data-index="' + i + '">' +
        '<img src="' + String(url).replace(/"/g, '&quot;') + '" alt="" />' +
        '<button type="button" class="design-photo-remove" aria-label="Remove">&times;</button></div>';
    }).join('');

    $('featuredPhotoGrid').querySelectorAll('.design-photo-tile').forEach(function (tile) {
      var idx = Number(tile.getAttribute('data-index'));
      tile.querySelector('.design-photo-remove, button').addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeFeatured(idx);
      });
      tile.addEventListener('click', function () {
        var featured = Array.isArray(state.tenant.featuredWorkImages) ? state.tenant.featuredWorkImages : [];
        openPhotoPreview({ kind: 'featured', index: idx, url: featured[idx] || '', aspect: 1 });
      });
    });
    $('galleryPhotoGrid').querySelectorAll('.design-photo-tile').forEach(function (tile) {
      var idx = Number(tile.getAttribute('data-index'));
      tile.querySelector('.design-photo-remove, button').addEventListener('click', function (ev) {
        ev.stopPropagation();
        removeGallery(idx);
      });
      tile.addEventListener('click', function () {
        var gallery = Array.isArray(state.tenant.galleryImages) ? state.tenant.galleryImages : [];
        openPhotoPreview({ kind: 'gallery', index: idx, url: gallery[idx] || '', aspect: 1 });
      });
    });
  }

  function fillContentForm() {
    var t = state.tenant || {};
    var copy = t.webCopyOverrides || {};
    var siteName = (copy['wc.site.displayName'] || t.displayName || '').trim();
    $('contentDisplayName').value = siteName;
    $('contentTagline').value = t.tagline || '';
    $('contentAbout').value = t.aboutText || '';
    $('contentPhone').value = t.contactPhone || '';
    $('contentEmail').value = t.contactEmail || '';
    $('contentAddress').value = t.contactAddress || '';
    $('contentSuite').value = t.contactAddressSuite || '';
  }

  function isTeamPlanTenant() {
    var plan = String((state.tenant && state.tenant.subscriptionPlan) || '').toLowerCase();
    return plan === 'studio' || plan === 'shop' || plan === 'growth' || plan === 'pro' || plan === 'enterprise';
  }

  function applyPageListForPlan() {
    var showTeam = isTeamPlanTenant();
    var teamBtn = document.querySelector('.design-nav-btn[data-path="/team"]');
    if (teamBtn) teamBtn.classList.toggle('hidden', !showTeam);
    var count = document.querySelectorAll('#panelPages .design-nav-btn:not(.hidden)').length;
    if (state.panel === 'pages' && $('panelMeta')) $('panelMeta').textContent = String(count);
    if (!showTeam && state.path === '/team') {
      state.path = '/';
      document.querySelectorAll('.design-nav-btn[data-path]').forEach(function (b) {
        b.classList.toggle('is-active', (b.getAttribute('data-path') || '/') === '/');
      });
    }
  }

  function fillBrandKit() {
    var t = state.tenant;
    function setPair(colorId, textId, value) {
      var hex = normalizeHex(value, '#FFFFFF');
      if ($(colorId)) $(colorId).value = hex;
      if ($(textId)) $(textId).value = hex;
    }
    setPair('colorBackground', 'colorBackgroundText', t.backgroundColor || '#FFFFFF');
    setPair('colorText', 'colorTextText', t.textColor || '#1A1410');
    setPair('colorPrimary', 'colorPrimaryText', t.primaryColor || '#2C2018');
    setPair('colorCard', 'colorCardText', t.cardSurfaceColor || '#F5F5F5');
    setPair('colorFeatured', 'colorFeaturedText', t.featuredWorkBackgroundColor || '#FAF8F5');
    setPair('colorAbout', 'colorAboutText', t.aboutSectionBackgroundColor || '#111111');
    $('toggleGalleryPage').checked = t.showGalleryPage !== false;
    $('toggleBookPage').checked = t.showBookPage !== false;
    $('toggleAboutPage').checked = t.showAboutPage !== false;
    $('toggleTeamPage').checked = t.showTeamPage !== false;
    $('toggleShop').checked = !!t.shopEnabled;
    applyPageListForPlan();
    $('announcementEnabled').checked = !!t.siteAnnouncementEnabled;
    $('announcementText').value = t.siteAnnouncementText || '';
    $('seoTitle').value = t.seoTitle || '';
    $('seoDescription').value = t.seoDescription || '';
  }

  function renderHealth() {
    var t = state.tenant || {};
    var copy = t.webCopyOverrides || {};
    var siteName = (copy['wc.site.displayName'] || t.displayName || '').trim();
    var items = [
      { ok: !!siteName, label: siteName ? 'Website name set' : 'Add a website name' },
      { ok: !!(t.heroImageUrl || '').trim(), label: (t.heroImageUrl || '').trim() ? 'Hero photo uploaded' : 'Hero photo missing' },
      { ok: Array.isArray(t.galleryImages) && t.galleryImages.length > 0, label: (Array.isArray(t.galleryImages) && t.galleryImages.length) ? 'Gallery has photos' : 'Gallery is empty' },
      { ok: !!(t.businessHoursWeekly || t.businessHours), label: (t.businessHoursWeekly || t.businessHours) ? 'Hours configured' : 'Set hours in the iPhone app' }
    ];
    $('healthList').innerHTML = items.map(function (it) {
      return '<li><span class="dot ' + (it.ok ? 'ok' : 'warn') + '"></span><span>' + it.label + '</span></li>';
    }).join('');
  }

  function setInspector(selection) {
    state.selected = selection;
    if (selection && selection.kind === 'sheet') {
      setMode('preview');
      setPanel('style');
    }
    $('inspectorEmpty').classList.add('hidden');
    $('inspectorField').classList.add('hidden');
    $('inspectorColor').classList.add('hidden');
    $('inspectorSheet').classList.add('hidden');

    if (!selection) {
      $('inspectorEmpty').classList.remove('hidden');
      syncEditBar();
      return;
    }
    if (selection.kind === 'sheet') {
      $('inspectorSheet').classList.remove('hidden');
      var label = 'Replace this photo';
      if (selection.key === 'heroImage') label = 'Replace hero photo';
      else if (String(selection.key).indexOf('featuredWork') === 0) label = 'Replace featured photo';
      else if (String(selection.key).indexOf('galleryImage') === 0) label = 'Replace gallery photo';
      else if (selection.key === 'studio12PhilosophyImage') label = 'Replace philosophy photo';
      else if (selection.key === 'studio12BookCtaImage') label = 'Replace book CTA photo';
      $('inspectorSheetHint').textContent = label;
      syncEditBar();
      return;
    }
    if (selection.kind === 'color') {
      $('inspectorColor').classList.remove('hidden');
      var field = SURFACE_TO_FIELD[selection.surface] || 'backgroundColor';
      var keyedHex = selection.surfaceKey && state.tenant.webSurfaceColors
        ? state.tenant.webSurfaceColors[selection.surfaceKey]
        : '';
      var stored = selection.surface === 'sidebar'
        ? (state.tenant.sidebarBackgroundColor || state.tenant.cardSurfaceColor || state.tenant.primaryColor)
        : '';
      var hex = normalizeHex(keyedHex || stored || state.tenant[field], '#FFFFFF');
      $('inspectorColorLabel').textContent = selection.surface === 'sidebar'
        ? 'Sidebar'
        : (selection.surfaceKey
          ? selection.surfaceKey + ' color'
          : (selection.surface || 'section') + ' color');
      $('inspectorColorInput').value = hex;
      $('inspectorColorText').value = hex;
      syncEditBar();
      return;
    }
    if (selection.kind === 'text') {
      $('inspectorField').classList.remove('hidden');
      var key = selection.key || '';
      var canon = canonicalTextKey(key);
      $('inspectorFieldLabel').textContent =
        FIELD_LABELS[canon] || FIELD_LABELS[key] || key.replace(/^wc\./, '').replace(/\./g, ' · ') || 'Text';
      $('inspectorFieldInput').value = selection.value || '';
      $('inspectorFieldHint').textContent = 'Type in the preview or here. Save when ready (⌘S).';
    }
    syncEditBar();
  }

  function canonicalTextKey(key) {
    if (!key) return key;
    if (key === 'displayName' || key.indexOf('displayName.') === 0) return 'wc.site.displayName';
    return key;
  }

  function setWebCopyOverride(wcKey, trimmed) {
    var map = Object.assign({}, state.tenant.webCopyOverrides || {});
    if (!trimmed) {
      delete map[wcKey];
    } else {
      map[wcKey] = trimmed;
    }
    return { webCopyOverrides: map };
  }

  function buildFieldUpdates(key, value) {
    var trimmed = String(value || '').replace(/^\s+|\s+$/g, '');
    var textKey = canonicalTextKey(key);
    if (!textKey) return null;

    // Unsupported on web — never write
    if (/^svc:/.test(textKey) || /^s12Process:/.test(textKey) ||
        /^charterFaq:/.test(textKey) || /^tm:/.test(textKey) || /:edit$/.test(textKey)) {
      var skip = {};
      skip['__skip_' + key] = trimmed;
      return skip;
    }

    if (textKey.indexOf('wc.') === 0) {
      return setWebCopyOverride(textKey, trimmed);
    }
    if (SITE_TEXT_FIELDS[textKey]) {
      var updates = {};
      updates[textKey] = trimmed;
      return updates;
    }
    return null;
  }

  function uploadTargetFromKey(key) {
    if (key === 'heroImage') return { type: 'hero' };
    if (key === 'studio12PhilosophyImage') return { type: 'philosophy' };
    if (key === 'studio12BookCtaImage') return { type: 'bookCta' };
    var fm = /^featuredWork(?::|)?(\d+)$/.exec(key) || /^featuredWork:(\d+)$/.exec(key);
    if (!fm && key.indexOf('featuredWork') === 0) {
      var n = key.replace(/\D/g, '');
      if (n !== '') return { type: 'featured', index: Number(n) };
      return { type: 'featured', index: -1 };
    }
    if (fm) return { type: 'featured', index: Number(fm[1]) };
    var gm = /^galleryImage(?::|)?(\d+)$/.exec(key) || /^galleryImage:(\d+)$/.exec(key);
    if (!gm && key.indexOf('galleryImage') === 0) {
      var g = key.replace(/\D/g, '');
      if (g !== '') return { type: 'gallery', index: Number(g) };
      return { type: 'gallery', index: -1 };
    }
    if (gm) return { type: 'gallery', index: Number(gm[1]) };
    return null;
  }

  /** Auto-fill image to aspect without showing the crop modal (used for batch gallery/featured). */
  function autoFillToBlob(file, aspect) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var maxW = 2000;
        var out = document.createElement('canvas');
        out.width = maxW;
        out.height = Math.round(maxW / (aspect || 1));
        var octx = out.getContext('2d');
        var scale = Math.max(out.width / img.width, out.height / img.height);
        var x = (out.width  - img.width  * scale) / 2;
        var y = (out.height - img.height * scale) / 2;
        octx.drawImage(img, x, y, img.width * scale, img.height * scale);
        URL.revokeObjectURL(url);
        out.toBlob(function (blob) {
          if (!blob) reject(new Error('Could not auto-fill image'));
          else resolve(blob);
        }, 'image/jpeg', 0.88);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not read image'));
      };
      img.src = url;
    });
  }

  function beginUpload(target) {
    state.uploadTarget = target;
    var picker = $('filePicker');
    picker.value = '';
    picker.multiple = (target.type === 'gallery' || target.type === 'featured') &&
      (target.index == null || target.index < 0);
    picker.click();
  }

  var CROP_FRAMES = [
    { label: 'Square',    ratio: 1       },
    { label: 'Portrait',  ratio: 4 / 5   },
    { label: 'Landscape', ratio: 4 / 3   },
    { label: 'Wide',      ratio: 16 / 9  },
    { label: 'Cinema',    ratio: 21 / 9  }
  ];

  function openCrop(file, aspect) {
    return new Promise(function (resolve, reject) {
      var isUrl = (typeof file === 'string');
      var url   = isUrl ? file : URL.createObjectURL(file);
      var img   = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        var canvas = $('cropCanvas');
        var stage  = $('cropStage');
        var modal  = $('cropModal');

        // ── frame picker ──────────────────────────────────────────────────
        var framePicker = $('cropFramePicker');
        var activeRatio = aspect || (16 / 9);
        (framePicker ? Array.from(framePicker.querySelectorAll('.design-frame-btn')) : [])
          .forEach(function (btn) {
            var r = parseFloat(btn.getAttribute('data-ratio'));
            btn.classList.toggle('is-active', Math.abs(r - activeRatio) < 0.01);
          });

        // ── canvas resize helper ──────────────────────────────────────────
        var cw, ch;
        function resizeCanvas(ratio) {
          cw = Math.min(720, stage.clientWidth || 720);
          ch = Math.round(cw / ratio);
          canvas.width  = cw;
          canvas.height = ch;
          cropState.aspect = ratio;
          var newMin = Math.max(cw / img.width, ch / img.height);
          var prevMin = minScale;
          // scale proportionally so image still fills the frame
          cropState.scale = Math.max(newMin, cropState.scale * (newMin / prevMin));
          minScale = newMin;
          maxScale = newMin * 6;
          // re-center
          cropState.x = (cw - img.width  * cropState.scale) / 2;
          cropState.y = (ch - img.height * cropState.scale) / 2;
          clampPos();
          syncSlider();
          draw();
        }

        cw = Math.min(720, stage.clientWidth || 720);
        ch = Math.round(cw / activeRatio);
        canvas.width  = cw;
        canvas.height = ch;

        var scale = Math.max(cw / img.width, ch / img.height);
        var cropState = {
          img:      img,
          scale:    scale,
          x:        (cw - img.width  * scale) / 2,
          y:        (ch - img.height * scale) / 2,
          dragging: false,
          lastX:    0,
          lastY:    0,
          aspect:   activeRatio
        };
        state.crop = cropState;
        var minScale = scale;
        var maxScale = minScale * 6;

        function draw() {
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#1a1410';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, cropState.x, cropState.y, img.width * cropState.scale, img.height * cropState.scale);
        }
        draw();

        function clampPos() {
          var iw = img.width  * cropState.scale;
          var ih = img.height * cropState.scale;
          cropState.x = Math.min(0, Math.max(cw - iw, cropState.x));
          cropState.y = Math.min(0, Math.max(ch - ih, cropState.y));
        }
        function applyScale(next, pivotX, pivotY) {
          next = Math.min(maxScale, Math.max(minScale, next));
          var ratio = next / cropState.scale;
          cropState.x = pivotX - (pivotX - cropState.x) * ratio;
          cropState.y = pivotY - (pivotY - cropState.y) * ratio;
          cropState.scale = next;
          clampPos();
          syncSlider();
          draw();
        }
        var slider = $('cropZoom');
        function syncSlider() {
          if (!slider) return;
          var t = (cropState.scale - minScale) / (maxScale - minScale);
          slider.value = Math.round(t * 100);
        }
        if (slider) {
          slider.value = 0;
          slider.oninput = function () {
            var t = Number(slider.value) / 100;
            applyScale(minScale + t * (maxScale - minScale), cw / 2, ch / 2);
          };
        }

        // ── frame picker clicks ───────────────────────────────────────────
        if (framePicker) {
          framePicker._cropHandler = function (ev) {
            var btn = ev.target.closest('.design-frame-btn');
            if (!btn) return;
            var r = parseFloat(btn.getAttribute('data-ratio'));
            framePicker.querySelectorAll('.design-frame-btn').forEach(function (b) {
              b.classList.toggle('is-active', b === btn);
            });
            resizeCanvas(r);
            if (slider) slider.value = 0;
          };
          framePicker.addEventListener('click', framePicker._cropHandler);
        }

        function onPointerDown(ev) {
          cropState.dragging = true;
          cropState.lastX = ev.clientX;
          cropState.lastY = ev.clientY;
          canvas.setPointerCapture(ev.pointerId);
        }
        function onPointerMove(ev) {
          if (!cropState.dragging) return;
          cropState.x += ev.clientX - cropState.lastX;
          cropState.y += ev.clientY - cropState.lastY;
          cropState.lastX = ev.clientX;
          cropState.lastY = ev.clientY;
          clampPos();
          draw();
        }
        function onPointerUp() { cropState.dragging = false; }
        function onWheel(ev) {
          ev.preventDefault();
          var delta = ev.deltaMode === 1 ? ev.deltaY * 30 : ev.deltaY;
          applyScale(cropState.scale * Math.exp(-delta * 0.002), ev.offsetX, ev.offsetY);
        }

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup',   onPointerUp);
        canvas.addEventListener('wheel',       onWheel, { passive: false });

        function cleanup() {
          canvas.removeEventListener('pointerdown', onPointerDown);
          canvas.removeEventListener('pointermove', onPointerMove);
          canvas.removeEventListener('pointerup',   onPointerUp);
          canvas.removeEventListener('wheel',       onWheel);
          if (framePicker && framePicker._cropHandler) {
            framePicker.removeEventListener('click', framePicker._cropHandler);
            framePicker._cropHandler = null;
          }
          modal.classList.add('hidden');
          modal.setAttribute('aria-hidden', 'true');
          if (!isUrl) URL.revokeObjectURL(url);
          state.crop = null;
        }

        function cancel() { cleanup(); reject(new Error('cancelled')); }

        function confirm() {
          var out  = document.createElement('canvas');
          var maxW = 2000;
          out.width  = maxW;
          out.height = Math.round(maxW / cropState.aspect);
          var octx = out.getContext('2d');
          var sx = -cropState.x / cropState.scale;
          var sy = -cropState.y / cropState.scale;
          var sw = canvas.width  / cropState.scale;
          var sh = canvas.height / cropState.scale;
          octx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
          out.toBlob(function (blob) {
            cleanup();
            if (!blob) reject(new Error('Could not export image'));
            else resolve(blob);
          }, 'image/jpeg', 0.9);
        }

        $('cropCancelBtn').onclick  = cancel;
        $('cropCancelBtn2').onclick = cancel;
        $('cropConfirmBtn').onclick = confirm;
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
        $('cropHint').textContent = 'Pick a frame, then drag & zoom to compose.';
      };
      img.onerror = function () {
        if (!isUrl) URL.revokeObjectURL(url);
        reject(new Error('Could not read image'));
      };
      img.src = url;
    });
  }

  /**
   * Opens the photo preview modal for an existing gallery or featured image.
   * Options: { kind:'gallery'|'featured', index:Number, url:String, aspect:Number }
   */
  function openPhotoPreview(opts) {
    var modal  = $('photoPreviewModal');
    var imgEl  = $('photoPreviewImg');
    var title  = $('photoPreviewTitle');
    if (!modal || !imgEl) return;

    imgEl.src = opts.url;
    title.textContent = opts.kind === 'gallery' ? 'Gallery photo ' + (opts.index + 1)
                                                : 'Featured photo ' + (opts.index + 1);
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');

    function close() {
      modal.classList.add('hidden');
      modal.setAttribute('aria-hidden', 'true');
      imgEl.src = '';
    }

    $('photoPreviewClose').onclick = close;

    $('photoPreviewRemove').onclick = function () {
      close();
      if (opts.kind === 'gallery') removeGallery(opts.index);
      else removeFeatured(opts.index);
    };

    $('photoPreviewReplace').onclick = function () {
      close();
      beginUpload({ type: opts.kind, index: opts.index });
    };

    $('photoPreviewRecrop').onclick = async function () {
      close();
      // Highlight initial frame button matching current stored aspect
      var picker = $('cropFramePicker');
      if (picker) {
        var bestBtn = null, bestDiff = Infinity;
        picker.querySelectorAll('.design-frame-btn').forEach(function (b) {
          var diff = Math.abs(parseFloat(b.getAttribute('data-ratio')) - (opts.aspect || 1));
          if (diff < bestDiff) { bestDiff = diff; bestBtn = b; }
        });
        picker.querySelectorAll('.design-frame-btn').forEach(function (b) {
          b.classList.toggle('is-active', b === bestBtn);
        });
      }
      try {
        // Fetch as blob first to avoid Firebase Storage CORS restrictions
        state.uploadTarget = { type: opts.kind, index: opts.index };
        setStatus('Loading photo…');
        var resp    = await fetch(opts.url);
        if (!resp.ok) throw new Error('Could not fetch photo (' + resp.status + ')');
        var imgBlob = await resp.blob();
        var blob    = await openCrop(imgBlob, opts.aspect || 1);
        await handleCroppedUpload(blob, {});
      } catch (err) {
        if (!err || err.message !== 'cancelled') {
          alert((err && err.message) || 'Could not re-crop photo');
        }
      } finally {
        state.uploadTarget = null;
      }
    };
  }

  async function uploadBlob(path, blob) {
    var ref = storage.ref().child(path);
    var meta = { contentType: 'image/jpeg' };
    await ref.put(blob, meta);
    return ref.getDownloadURL();
  }

  async function persistTenant(updates) {
    noteHistoryBeforeEdit();
    await db.collection('tenants').doc(state.tenantId).update(updates);
    Object.keys(updates).forEach(function (k) { state.tenant[k] = updates[k]; });
    updateHistoryButtons();
  }

  async function handleCroppedUpload(blob, options) {
    options = options || {};
    var clearTarget = options.clearTarget !== false;
    var target = state.uploadTarget;
    if (!target) return;
    setStatus('Uploading…');
    try {
      if (target.type === 'hero') {
        var heroUrl = await uploadBlob('tenants/' + state.tenantId + '/hero.jpg', blob);
        var dims = await blobDims(blob);
        await persistTenant({
          heroImageUrl: heroUrl,
          heroImagePixelWidth: dims.w,
          heroImagePixelHeight: dims.h
        });
      } else if (target.type === 'philosophy') {
        var pUrl = await uploadBlob('tenants/' + state.tenantId + '/gallery/' + uid() + '.jpg', blob);
        var pDims = await blobDims(blob);
        await persistTenant({
          studio12PhilosophyImageUrl: pUrl,
          studio12PhilosophyImagePixelWidth: pDims.w,
          studio12PhilosophyImagePixelHeight: pDims.h
        });
      } else if (target.type === 'bookCta') {
        var bUrl = await uploadBlob('tenants/' + state.tenantId + '/gallery/' + uid() + '.jpg', blob);
        var bDims = await blobDims(blob);
        await persistTenant({
          studio12BookCtaImageUrl: bUrl,
          studio12BookCtaImagePixelWidth: bDims.w,
          studio12BookCtaImagePixelHeight: bDims.h
        });
      } else if (target.type === 'featured') {
        var fUrl = await uploadBlob('tenants/' + state.tenantId + '/gallery/' + uid() + '.jpg', blob);
        var featured = Array.isArray(state.tenant.featuredWorkImages) ? state.tenant.featuredWorkImages.slice() : [];
        if (target.index >= 0 && target.index < featured.length) featured[target.index] = fUrl;
        else featured.push(fUrl);
        await persistTenant({ featuredWorkImages: featured });
      } else if (target.type === 'gallery') {
        var gUrl = await uploadBlob('tenants/' + state.tenantId + '/gallery/' + uid() + '.jpg', blob);
        var gallery = Array.isArray(state.tenant.galleryImages) ? state.tenant.galleryImages.slice() : [];
        if (target.index >= 0 && target.index < gallery.length) gallery[target.index] = gUrl;
        else gallery.push(gUrl);
        await persistTenant({ galleryImages: gallery });
      }
      setStatus('Uploaded', 'is-ok');
      renderPhotos();
      renderHealth();
      loadPreview();
    } catch (err) {
      console.error(err);
      setStatus('Upload failed', 'is-err');
      alert((err && err.message) || 'Upload failed');
    } finally {
      if (clearTarget) state.uploadTarget = null;
    }
  }

  function blobDims(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        resolve({ w: img.naturalWidth || 16, h: img.naturalHeight || 9 });
        URL.revokeObjectURL(url);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve({ w: 16, h: 9 });
      };
      img.src = url;
    });
  }

  async function removeFeatured(index) {
    var featured = Array.isArray(state.tenant.featuredWorkImages) ? state.tenant.featuredWorkImages.slice() : [];
    if (index < 0 || index >= featured.length) return;
    featured.splice(index, 1);
    try {
      await persistTenant({ featuredWorkImages: featured });
      renderPhotos();
      loadPreview();
    } catch (err) {
      alert((err && err.message) || 'Could not remove photo');
    }
  }

  async function removeGallery(index) {
    var gallery = Array.isArray(state.tenant.galleryImages) ? state.tenant.galleryImages.slice() : [];
    if (index < 0 || index >= gallery.length) return;
    gallery.splice(index, 1);
    try {
      await persistTenant({ galleryImages: gallery });
      renderPhotos();
      renderHealth();
      loadPreview();
    } catch (err) {
      alert((err && err.message) || 'Could not remove photo');
    }
  }

  async function savePending() {
    if (!state.tenantId || state.saving) return;
    var payload = {};
    Object.keys(state.pending).forEach(function (k) {
      if (k.indexOf('__skip_') === 0) return;
      payload[k] = state.pending[k];
    });
    if (!Object.keys(payload).length) {
      markClean();
      return;
    }
    state.saving = true;
    setStatus('Saving…');
    try {
      await db.collection('tenants').doc(state.tenantId).update(payload);
      markClean();
      setStatus('Saved', 'is-ok');
      var needsReload = Object.keys(payload).some(function (k) {
        return /^(webCopyOverrides|webButtonColors|show|seo|siteAnnouncement|displayName|tagline|aboutText|contact|shopEnabled|bookingFormStyleId|formSchema|guidedStep|reviews)/.test(k);
      });
      if (needsReload) loadPreview();
      else pushLivePreview();
      renderHealth();
    } catch (err) {
      console.error(err);
      setStatus('Save failed', 'is-err');
      alert((err && err.message) || 'Could not save.');
    } finally {
      state.saving = false;
    }
  }

  function loadPreview() {
    state.bridgeReady = false;
    $('previewFrame').src = previewSrc();
    watchLocalPreviewHandshake();
  }

  function watchLocalPreviewHandshake() {
    if (!isLocalDesignShell() || !state.slug) return;
    if (state.previewWatch) clearTimeout(state.previewWatch);
    state.previewWatch = setTimeout(function () {
      if (state.bridgeReady) return;
      var cands = localBookingCandidates();
      state.previewTry = (state.previewTry || 0) + 1;
      if (state.previewTry >= cands.length) return;
      state.previewUrl = cands[state.previewTry] + '/' + encodeURIComponent(state.slug);
      loadPreview();
    }, 1800);
  }

  function enableBridgeWhenReady() {
    postToFrame('ping');
    postEditMode();
  }

  function bridgeOriginOk(origin) {
    if (!origin) return false;
    var siteOrigin = previewOrigin();
    if (siteOrigin && origin === siteOrigin) return true;
    var frame = $('previewFrame');
    if (!frame || !frame.src) return false;
    try { return new URL(frame.src).origin === origin; } catch (e) { return false; }
  }

  function onBridgeMessage(ev) {
    var data = ev.data;
    if (!data || data.source !== 'bk-design-bridge') return;
    if (!bridgeOriginOk(ev.origin)) return;

    if (data.type === 'hello' || data.type === 'pong' || data.type === 'ready') {
      state.bridgeReady = true;
      if (data.payload && data.payload.href) syncPathFromPreviewHref(data.payload.href);
      if (isLocalDesignShell() && !(data.payload && data.payload.cardClicks) && !state.forcedBridgeReload) {
        state.forcedBridgeReload = true;
        loadPreview();
        return;
      }
      postEditMode();
      return;
    }
    if (data.type === 'role-keys') {
      var painted = (data.payload && data.payload.keys) || [];
      var paintedHex = (data.payload && data.payload.hex) || '';
      if (!painted.length || paintedHex.charAt(0) !== '#') return;
      var surfaceMap = Object.assign({}, state.tenant.webSurfaceColors || {});
      var changed = false;
      painted.forEach(function (key) {
        if (surfaceMap[key] !== paintedHex) {
          surfaceMap[key] = paintedHex;
          changed = true;
        }
      });
      if (!changed) return;
      queueUpdate({ webSurfaceColors: surfaceMap });
      pushLivePreview();
      return;
    }
    if (data.type === 'color-sample') {
      var seenHex = (data.payload && data.payload.hex) || '';
      var seen = $('editBarSeen');
      if (seen) seen.textContent = seenHex ? seenHex : '';
      return;
    }
    if (data.type === 'section-open') {
      state.sectionOpenedAt = Date.now();
      openSection(data.payload || null);
      return;
    }
    if (data.type === 'section-refresh') {
      if (state.panel !== 'section' || !data.payload) return;
      var panel = $('panelSection');
      var keepScroll = panel ? panel.scrollTop : 0;
      state.section = data.payload;
      renderSectionBody(data.payload);
      if (panel) panel.scrollTop = keepScroll;
      return;
    }
    if (data.type === 'field-select') {
      if (!data.payload && state.panel === 'section') {
        if (state.sectionOpenedAt && Date.now() - state.sectionOpenedAt < 600) return;
        state.section = null;
        setPanel(state.returnPanel || 'pages');
        return;
      }
      setInspector(data.payload || null);
      if (data.payload && data.payload.kind === 'sheet') {
        setMode('preview');
        setPanel('style');
      }
      return;
    }
    if (data.type === 'photo-upload') {
      var uploadKey = (data.payload || {}).key;
      if (!uploadKey) return;
      setInspector({ kind: 'sheet', key: uploadKey });
      var target = uploadTargetFromKey(uploadKey);
      if (!target) {
        alert('This photo type isn’t supported in the web editor yet.');
        return;
      }
      beginUpload(target);
      return;
    }
    if (data.type === 'field-input') {
      var liveKey = (data.payload || {}).key;
      var liveValue = (data.payload || {}).value;
      if (!liveKey) return;
      if (state.selected && state.selected.kind === 'text' && state.selected.key === liveKey) {
        $('inspectorFieldInput').value = liveValue || '';
        state.selected.value = liveValue || '';
      } else {
        setInspector({ kind: 'text', key: liveKey, value: liveValue || '' });
      }
      return;
    }
    if (data.type === 'field-edit') {
      var key = (data.payload || {}).key;
      var value = (data.payload || {}).value;
      if (!key) return;
      var updates = buildFieldUpdates(key, value);
      if (!updates || updates['__skip_' + key] !== undefined) {
        setInspector({ kind: 'text', key: key, value: value });
        if (updates && updates['__skip_' + key] !== undefined) {
          $('inspectorFieldHint').textContent = 'This field still edits in the iPhone app.';
        }
        return;
      }
      queueUpdate(updates);
      setInspector({ kind: 'text', key: key, value: value });
    }
  }

  function surfacesForColorField(field) {
    if (field === 'backgroundColor') return ['page', 'hero'];
    if (field === 'cardSurfaceColor') return ['card'];
    if (field === 'featuredWorkBackgroundColor') return ['featured', 'gallery'];
    if (field === 'aboutSectionBackgroundColor') return ['about'];
    return [];
  }

  function bindColorPair(colorId, textId, field) {
    var colorEl = $(colorId);
    var textEl = $(textId);
    function apply(hex) {
      hex = normalizeHex(hex, state.tenant[field] || '#000000');
      colorEl.value = hex;
      textEl.value = hex;
      var patch = {};
      patch[field] = hex;
      if (field === 'primaryColor') patch.primaryColorHover = hex;
      if (field === 'featuredWorkBackgroundColor') patch.galleryPageBackgroundColor = hex;
      queueUpdate(patch);
      pushLivePreview();
      var surfaces = surfacesForColorField(field);
      if (surfaces.length) postToFrame('paint-role', { surfaces: surfaces, hex: hex });
    }
    colorEl.addEventListener('input', function () { apply(colorEl.value); });
    textEl.addEventListener('change', function () { apply(textEl.value); });
  }

  var BOOK_SUBMIT_KEY = 'wc.book.submit';
  var FORM_STYLE_HINT = {
    standard: 'Classic card with dropdowns and stacked fields.',
    guided: 'Multi-step wizard for service, project details, and contact info.'
  };
  var FIELD_TYPE_OPTIONS = [
    ['text', 'Text'],
    ['email', 'Email'],
    ['phone', 'Phone'],
    ['textarea', 'Long text'],
    ['file', 'File / photos'],
    ['select', 'Dropdown']
  ];
  var DEFAULT_FORM_FIELDS = [
    { key: 'name', label: 'Full Name', type: 'text', required: true, options: [], placeholder: '' },
    { key: 'email', label: 'Email', type: 'email', required: true, options: [], placeholder: '' },
    { key: 'phone', label: 'Phone', type: 'phone', required: true, options: [], placeholder: '' },
    { key: 'referenceImages', label: 'Reference photos (optional)', type: 'file', required: false, options: [], placeholder: '' },
    { key: 'notes', label: 'Notes', type: 'textarea', required: false, options: [], placeholder: '' }
  ];

  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showsSiteReviews() {
    var family = currentThemeFamily();
    return family === 'blade' || family === 'studio12';
  }

  function resolvedFormStyle() {
    var raw = String((state.tenant && state.tenant.bookingFormStyleId) || '').trim().toLowerCase();
    return raw === 'guided' ? 'guided' : 'standard';
  }

  function guidedDefaults() {
    var industry = String((state.tenant && state.tenant.industry) || 'custom').trim().toLowerCase();
    var project = {
      barber: 'Cut',
      hair: 'Style',
      tattoos: 'Design',
      nails: 'Details',
      charters: 'Trip details'
    }[industry] || 'Project details';
    var contact = (industry === 'barber' || industry === 'hair' || industry === 'tattoos' || industry === 'nails')
      ? 'You'
      : 'About you';
    return { service: 'Service', project: project, contact: contact, confirm: 'Confirm' };
  }

  function guidedTitle(key) {
    var titles = (state.tenant && state.tenant.guidedStepTitles) || {};
    var custom = String(titles[key] || '').trim();
    return custom || guidedDefaults()[key] || key;
  }

  function normalizeField(raw) {
    var type = String((raw && raw.type) || 'text');
    var allowed = { text: 1, email: 1, phone: 1, textarea: 1, file: 1, select: 1 };
    if (!allowed[type]) type = 'text';
    return {
      key: String((raw && raw.key) || '').trim(),
      label: String((raw && raw.label) || (raw && raw.key) || 'Field').trim(),
      type: type,
      required: !raw || raw.required !== false,
      options: Array.isArray(raw && raw.options) ? raw.options.map(function (item) { return String(item); }) : [],
      placeholder: raw && raw.placeholder ? String(raw.placeholder) : ''
    };
  }

  function fieldsForEdit() {
    var schema = state.tenant && state.tenant.formSchema;
    if (Array.isArray(schema) && schema.length) return schema.map(normalizeField);
    return DEFAULT_FORM_FIELDS.map(normalizeField);
  }

  function toFirestoreField(field) {
    var row = {
      key: field.key,
      label: field.label,
      type: field.type,
      required: !!field.required
    };
    if (field.type === 'select' && field.options && field.options.length) row.options = field.options.slice();
    if (field.placeholder) row.placeholder = field.placeholder;
    return row;
  }

  function slugifyField(label, fields, selfIndex) {
    var base = String(label || 'field').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'field';
    var used = {};
    fields.forEach(function (field, index) {
      if (index !== selfIndex && field.key) used[field.key] = true;
    });
    if (!used[base]) return base;
    var n = 2;
    while (used[base + n]) n += 1;
    return base + n;
  }

  function commitFields(fields) {
    queueUpdate({ formSchema: fields.map(toFirestoreField) });
    syncBookFieldsSummary();
  }

  function reviewsForEdit() {
    var list = state.tenant && state.tenant.reviews;
    if (!Array.isArray(list)) return [];
    return list.slice(0, 3).map(function (row) {
      return {
        quote: String((row && row.quote) || ''),
        name: String((row && row.name) || ''),
        service: String((row && row.service) || '')
      };
    });
  }

  function commitReviews(list) {
    queueUpdate({
      reviews: list.slice(0, 3).map(function (row) {
        var out = { quote: row.quote || '', name: row.name || '' };
        var service = String(row.service || '').trim();
        if (service) out.service = service;
        return out;
      })
    });
  }

  function serviceSubtitle(service) {
    var price = Number(service.price);
    var priceLabel = price > 0
      ? (Math.round(price) === price ? ('From $' + price) : ('From $' + price.toFixed(2)))
      : 'Book for pricing';
    var parts = [priceLabel];
    if (service.durationMinutes > 0) parts.push(service.durationMinutes + ' min');
    return parts.join(' · ');
  }

  function uniqueServiceSlug(name, selfId) {
    var base = String(name || 'service').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'service';
    var used = {};
    state.booking.services.forEach(function (service) {
      if (service.id !== selfId && service.slug) used[service.slug] = true;
    });
    if (!used[base]) return base;
    var n = 2;
    while (used[base + '-' + n]) n += 1;
    return base + '-' + n;
  }

  function syncBookFieldsSummary() {
    var guided = resolvedFormStyle() === 'guided';
    var count = fieldsForEdit().length;
    if ($('bookFieldsTitle')) $('bookFieldsTitle').textContent = guided ? 'Guided steps' : 'Form fields';
    if ($('bookFieldsMeta')) {
      $('bookFieldsMeta').textContent = guided
        ? ('4 steps · ' + count + ' fields')
        : (count + (count === 1 ? ' field' : ' fields'));
    }
    if ($('bookFieldsEditLabel')) $('bookFieldsEditLabel').textContent = state.booking.fieldsOpen ? 'Done' : 'Edit';
    var editor = $('bookFieldsEditor');
    if (editor) editor.classList.toggle('hidden', !state.booking.fieldsOpen);
  }

  function renderFieldsEditor() {
    var editor = $('bookFieldsEditor');
    if (!editor) return;
    if (!state.booking.fieldsOpen) {
      editor.innerHTML = '';
      return;
    }
    var html = '';
    if (resolvedFormStyle() === 'guided') {
      var stepLabels = { service: 'Step 1', project: 'Step 2', contact: 'Step 3', confirm: 'Step 4' };
      html += ['service', 'project', 'contact', 'confirm'].map(function (key) {
        return '<div class="design-field"><label>' + stepLabels[key] + '</label>' +
          '<input type="text" data-step="' + key + '" value="' + escHtml(guidedTitle(key)) + '" /></div>';
      }).join('');
    }
    html += fieldsForEdit().map(function (field, index) {
      var typeOpts = FIELD_TYPE_OPTIONS.map(function (opt) {
        return '<option value="' + opt[0] + '"' + (field.type === opt[0] ? ' selected' : '') + '>' + escHtml(opt[1]) + '</option>';
      }).join('');
      var optionsHtml = field.type === 'select'
        ? '<div class="design-field"><label>Choices</label><input type="text" data-field="options" data-index="' + index + '" value="' + escHtml((field.options || []).join(', ')) + '" placeholder="Small, Medium, Large" /></div>'
        : '';
      return '<div class="design-book-field">' +
        '<div class="design-field"><label>Label</label><input type="text" data-field="label" data-index="' + index + '" value="' + escHtml(field.label) + '" /></div>' +
        '<div class="design-field"><label>Type</label><select data-field="type" data-index="' + index + '">' + typeOpts + '</select></div>' +
        optionsHtml +
        '<label class="design-check"><input type="checkbox" data-field="required" data-index="' + index + '"' + (field.required ? ' checked' : '') + ' /><span>Required</span></label>' +
        '<button type="button" class="design-text-btn" data-remove-field="' + index + '">Remove</button>' +
        '</div>';
    }).join('');
    html += '<button type="button" class="design-text-btn" id="addFieldBtn">Add field</button>';
    editor.innerHTML = html;

    editor.querySelectorAll('[data-step]').forEach(function (input) {
      input.addEventListener('input', function () {
        var key = input.getAttribute('data-step');
        var titles = Object.assign({}, (state.tenant && state.tenant.guidedStepTitles) || {});
        var value = input.value.trim();
        if (!value || value === guidedDefaults()[key]) delete titles[key];
        else titles[key] = value;
        queueUpdate({ guidedStepTitles: titles });
      });
    });
    editor.querySelectorAll('[data-field]').forEach(function (input) {
      var kind = input.getAttribute('data-field');
      input.addEventListener(kind === 'label' || kind === 'options' ? 'input' : 'change', function () {
        var index = parseInt(input.getAttribute('data-index'), 10);
        var fields = fieldsForEdit();
        var field = fields[index];
        if (!field) return;
        if (kind === 'label') {
          field.label = input.value.trim() || field.label;
          if (!field.key) field.key = slugifyField(field.label, fields, index);
        } else if (kind === 'type') {
          field.type = input.value;
        } else if (kind === 'required') {
          field.required = !!input.checked;
        } else if (kind === 'options') {
          field.options = input.value.split(',').map(function (item) { return item.trim(); }).filter(Boolean);
        }
        commitFields(fields);
        if (kind === 'type') renderFieldsEditor();
      });
    });
    editor.querySelectorAll('[data-remove-field]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fields = fieldsForEdit();
        fields.splice(parseInt(btn.getAttribute('data-remove-field'), 10), 1);
        commitFields(fields);
        renderFieldsEditor();
      });
    });
    var addBtn = $('addFieldBtn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var fields = fieldsForEdit();
        fields.push({
          key: slugifyField('Field', fields, -1),
          label: 'New field',
          type: 'text',
          required: false,
          options: [],
          placeholder: ''
        });
        commitFields(fields);
        renderFieldsEditor();
      });
    }
  }

  function serviceEditorEl(id) {
    var found = null;
    document.querySelectorAll('[data-service-editor]').forEach(function (el) {
      if (el.getAttribute('data-service-editor') === id) found = el;
    });
    return found;
  }

  function readServiceEditor(id) {
    var editor = serviceEditorEl(id);
    if (!editor) return null;
    var name = ((editor.querySelector('[data-svc="name"]') || {}).value || '').trim();
    var priceRaw = (editor.querySelector('[data-svc="price"]') || {}).value || '';
    var durationRaw = (editor.querySelector('[data-svc="duration"]') || {}).value || '';
    var description = ((editor.querySelector('[data-svc="description"]') || {}).value || '').trim();
    var price = parseFloat(String(priceRaw).replace(/[^0-9.]/g, ''));
    var duration = parseInt(durationRaw, 10);
    return {
      name: name || 'Service',
      price: price > 0 ? price : 0,
      durationMinutes: duration > 0 ? duration : 0,
      description: description
    };
  }

  function paintServiceRow(service) {
    var row = null;
    document.querySelectorAll('#bookServices [data-service]').forEach(function (el) {
      if (el.getAttribute('data-service') === service.id) row = el;
    });
    if (!row) return;
    var nameEl = row.querySelector('strong');
    var metaEl = row.querySelector('em');
    if (nameEl) nameEl.textContent = service.name;
    if (metaEl) metaEl.textContent = serviceSubtitle(service);
  }

  async function writeServiceDoc(service) {
    var del = firebase.firestore.FieldValue.delete();
    var index = state.booking.services.indexOf(service);
    await db.collection('tenants').doc(state.tenantId).collection('services').doc(service.id).set({
      name: service.name,
      slug: service.slug || uniqueServiceSlug(service.name, service.id),
      isActive: true,
      sortOrder: index < 0 ? state.booking.services.length : index,
      durationMinutes: service.durationMinutes > 0 ? service.durationMinutes : del,
      description: service.description ? service.description : del,
      price: service.price > 0 ? service.price : del
    }, { merge: true });
    loadPreview();
  }

  function scheduleServiceSave(id) {
    var draft = readServiceEditor(id);
    if (!draft) return;
    if (state.booking.serviceTimer) clearTimeout(state.booking.serviceTimer);
    state.booking.serviceTimer = setTimeout(function () {
      state.booking.serviceTimer = null;
      saveServiceDraft(id, draft);
    }, 400);
  }

  async function saveServiceDraft(id, draft) {
    var service = state.booking.services.filter(function (item) { return item.id === id; })[0];
    if (!draft || !service || !state.tenantId) return;
    service.name = draft.name;
    service.price = draft.price;
    service.durationMinutes = draft.durationMinutes;
    service.description = draft.description;
    service.slug = uniqueServiceSlug(service.name, service.id);
    paintServiceRow(service);
    try {
      await writeServiceDoc(service);
    } catch (err) {
      alert((err && err.message) || 'Could not save service');
    }
  }

  async function moveService(index, dir) {
    var list = state.booking.services;
    var next = index + dir;
    if (!list[index] || !list[next] || !state.tenantId) return;
    var swapped = list[index];
    list[index] = list[next];
    list[next] = swapped;
    renderServices();
    try {
      var batch = db.batch();
      list.forEach(function (service, i) {
        service.sortOrder = i;
        batch.set(
          db.collection('tenants').doc(state.tenantId).collection('services').doc(service.id),
          { sortOrder: i },
          { merge: true }
        );
      });
      await batch.commit();
      loadPreview();
    } catch (err) {
      alert((err && err.message) || 'Could not reorder services');
    }
  }

  async function addService() {
    if (!state.tenantId) return;
    var ref = db.collection('tenants').doc(state.tenantId).collection('services').doc();
    var service = {
      id: ref.id,
      name: 'New service',
      slug: uniqueServiceSlug('New service', ref.id),
      price: 0,
      durationMinutes: 0,
      description: '',
      sortOrder: state.booking.services.length
    };
    try {
      await ref.set({
        name: service.name,
        slug: service.slug,
        isActive: true,
        sortOrder: service.sortOrder
      });
      state.booking.services.push(service);
      state.booking.serviceOpenId = service.id;
      renderBookingPanel();
      loadPreview();
    } catch (err) {
      alert((err && err.message) || 'Could not add service');
    }
  }

  function closeConfirmModal() {
    var modal = $('confirmModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
    state.confirmAction = null;
  }

  function openConfirmModal(opts) {
    var modal = $('confirmModal');
    if (!modal) return;
    if ($('confirmModalTitle')) $('confirmModalTitle').textContent = opts.title || 'Confirm';
    if ($('confirmModalBody')) $('confirmModalBody').textContent = opts.body || '';
    if ($('confirmModalOk')) $('confirmModalOk').textContent = opts.confirmLabel || 'OK';
    state.confirmAction = opts.onConfirm || null;
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    if ($('confirmModalCancel')) $('confirmModalCancel').focus();
  }

  function bindConfirmModal() {
    function cancel() { closeConfirmModal(); }
    if ($('confirmModalCancel')) $('confirmModalCancel').addEventListener('click', cancel);
    if ($('confirmModalClose')) $('confirmModalClose').addEventListener('click', cancel);
    if ($('confirmModal')) {
      $('confirmModal').addEventListener('click', function (ev) {
        if (ev.target === $('confirmModal')) cancel();
      });
    }
    if ($('confirmModalOk')) {
      $('confirmModalOk').addEventListener('click', function () {
        var action = state.confirmAction;
        closeConfirmModal();
        if (action) action();
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var modal = $('confirmModal');
      if (!modal || modal.classList.contains('hidden')) return;
      ev.preventDefault();
      closeConfirmModal();
    });
  }

  async function deleteService(id) {
    try {
      await db.collection('tenants').doc(state.tenantId).collection('services').doc(id).delete();
      state.booking.services = state.booking.services.filter(function (service) { return service.id !== id; });
      if (state.booking.serviceOpenId === id) state.booking.serviceOpenId = null;
      renderBookingPanel();
      loadPreview();
    } catch (err) {
      alert((err && err.message) || 'Could not remove service');
    }
  }

  function removeService(id) {
    if (!state.tenantId || !id) return;
    var service = state.booking.services.filter(function (item) { return item.id === id; })[0];
    var name = service && service.name ? service.name : 'this service';
    openConfirmModal({
      title: 'Remove service',
      body: name + ' will come off the booking form.',
      confirmLabel: 'Remove',
      onConfirm: function () { deleteService(id); }
    });
  }

  function renderServices() {
    var host = $('bookServices');
    if (!host) return;
    if (state.booking.servicesError) {
      host.innerHTML = '<p class="design-hint">' + escHtml(state.booking.servicesError) + '</p>';
      return;
    }
    if (!state.booking.services.length) {
      host.innerHTML = '<p class="design-hint">No services yet. Add one so clients can book.</p>';
      return;
    }
    host.innerHTML = state.booking.services.map(function (service, index) {
      var open = state.booking.serviceOpenId === service.id;
      var row = '<div class="design-sec-row" data-service="' + escHtml(service.id) + '" role="button" tabindex="0">' +
        '<span><strong>' + escHtml(service.name) + '</strong><em>' + escHtml(serviceSubtitle(service)) + '</em></span>' +
        '<span class="design-book-row-actions">' +
          '<button type="button" class="design-book-icon-btn" data-move="-1" data-index="' + index + '"' + (index === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
          '<button type="button" class="design-book-icon-btn" data-move="1" data-index="' + index + '"' + (index === state.booking.services.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
        '</span></div>';
      if (!open) return row;
      return row + '<div class="design-book-editor" data-service-editor="' + escHtml(service.id) + '">' +
        '<div class="design-field"><label>Name</label><input type="text" data-svc="name" value="' + escHtml(service.name) + '" /></div>' +
        '<div class="design-field"><label>Price</label><input type="text" data-svc="price" value="' + (service.price > 0 ? escHtml(String(service.price)) : '') + '" placeholder="Optional" /></div>' +
        '<div class="design-field"><label>Duration (minutes)</label><input type="number" min="0" step="5" data-svc="duration" value="' + (service.durationMinutes > 0 ? String(service.durationMinutes) : '') + '" /></div>' +
        '<div class="design-field"><label>Description</label><textarea data-svc="description">' + escHtml(service.description || '') + '</textarea></div>' +
        '<button type="button" class="design-text-btn" data-remove-service="' + escHtml(service.id) + '">Remove service</button>' +
        '</div>';
    }).join('');

    host.querySelectorAll('[data-service]').forEach(function (row) {
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('[data-move]')) return;
        var id = row.getAttribute('data-service');
        state.booking.serviceOpenId = state.booking.serviceOpenId === id ? null : id;
        renderServices();
      });
      row.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (ev.target.closest('[data-move]')) return;
        ev.preventDefault();
        var id = row.getAttribute('data-service');
        state.booking.serviceOpenId = state.booking.serviceOpenId === id ? null : id;
        renderServices();
      });
    });
    host.querySelectorAll('[data-move]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        moveService(parseInt(btn.getAttribute('data-index'), 10), parseInt(btn.getAttribute('data-move'), 10));
      });
    });
    host.querySelectorAll('[data-service-editor] input, [data-service-editor] textarea').forEach(function (input) {
      input.addEventListener('input', function () {
        var editor = input.closest('[data-service-editor]');
        if (editor) scheduleServiceSave(editor.getAttribute('data-service-editor'));
      });
    });
    host.querySelectorAll('[data-remove-service]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeService(btn.getAttribute('data-remove-service'));
      });
    });
  }

  function renderReviews() {
    var host = $('bookReviews');
    var addBtn = $('addReviewBtn');
    if (!host) return;
    if (!showsSiteReviews()) {
      host.innerHTML = '';
      if (addBtn) addBtn.classList.add('hidden');
      return;
    }
    var reviews = reviewsForEdit();
    if (!reviews.length) {
      host.innerHTML = '<p class="design-hint">No reviews yet.</p>';
    } else {
      host.innerHTML = reviews.map(function (rev, index) {
        return '<div class="design-book-field">' +
          '<div class="design-field"><label>Quote</label><textarea data-review="quote" data-index="' + index + '">' + escHtml(rev.quote) + '</textarea></div>' +
          '<div class="design-field"><label>Name</label><input type="text" data-review="name" data-index="' + index + '" value="' + escHtml(rev.name) + '" /></div>' +
          '<div class="design-field"><label>Service</label><input type="text" data-review="service" data-index="' + index + '" value="' + escHtml(rev.service) + '" /></div>' +
          '<button type="button" class="design-text-btn" data-remove-review="' + index + '">Remove</button>' +
          '</div>';
      }).join('');
    }
    if (addBtn) addBtn.classList.toggle('hidden', reviews.length >= 3);
    host.querySelectorAll('[data-review]').forEach(function (input) {
      input.addEventListener('input', function () {
        var list = reviewsForEdit();
        var index = parseInt(input.getAttribute('data-index'), 10);
        if (!list[index]) return;
        list[index][input.getAttribute('data-review')] = input.value;
        commitReviews(list);
      });
    });
    host.querySelectorAll('[data-remove-review]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var list = reviewsForEdit();
        list.splice(parseInt(btn.getAttribute('data-remove-review'), 10), 1);
        commitReviews(list);
        renderReviews();
      });
    });
  }

  function renderBookingPanel() {
    if (!state.tenant) return;
    var style = resolvedFormStyle();
    if ($('bookFormStyle')) $('bookFormStyle').value = style;
    if ($('bookFormStyleHint')) $('bookFormStyleHint').textContent = FORM_STYLE_HINT[style];
    var labelEl = $('bookSubmitLabel');
    if (labelEl && document.activeElement !== labelEl) {
      labelEl.value = ((state.tenant.webCopyOverrides || {})[BOOK_SUBMIT_KEY]) || '';
    }
    var hex = normalizeHex(
      ((state.tenant.webButtonColors || {})[BOOK_SUBMIT_KEY]) || state.tenant.primaryColor,
      '#2C2018'
    );
    if ($('bookSubmitColor') && document.activeElement !== $('bookSubmitColor')) $('bookSubmitColor').value = hex;
    if ($('bookSubmitColorText') && document.activeElement !== $('bookSubmitColorText')) $('bookSubmitColorText').value = hex;
    var reviewsWrap = $('bookReviewsWrap');
    if (reviewsWrap) reviewsWrap.classList.toggle('hidden', !showsSiteReviews());
    syncBookFieldsSummary();
    renderFieldsEditor();
    renderServices();
    renderReviews();
    if ($('panelMeta') && state.panel === 'booking') {
      var count = state.booking.services.length;
      $('panelMeta').textContent = count ? (count + (count === 1 ? ' service' : ' services')) : '';
    }
  }

  async function loadBookingServices() {
    state.booking.services = [];
    state.booking.servicesError = '';
    if (!state.tenantId) return;
    try {
      var snap = await db.collection('tenants').doc(state.tenantId).collection('services').get();
      var rows = [];
      snap.forEach(function (doc) {
        var data = doc.data() || {};
        if (data.isActive === false || !data.name) return;
        var price = Number(data.price);
        var duration = parseInt(data.durationMinutes, 10);
        rows.push({
          id: doc.id,
          name: String(data.name),
          slug: String(data.slug || ''),
          price: price > 0 ? price : 0,
          durationMinutes: duration > 0 ? duration : 0,
          description: String(data.description || ''),
          sortOrder: typeof data.sortOrder === 'number' ? data.sortOrder : 999999
        });
      });
      rows.sort(function (a, b) {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return String(a.name).localeCompare(String(b.name));
      });
      state.booking.services = rows;
    } catch (err) {
      state.booking.servicesError = (err && err.message) || 'Could not load services';
    }
    if (state.panel === 'booking') renderBookingPanel();
  }

  function applyBookButtonColor(hex) {
    if (!state.tenant) return;
    var clean = normalizeHex(hex, 'bad');
    if (clean === 'bad') return;
    var map = Object.assign({}, state.tenant.webButtonColors || {});
    map[BOOK_SUBMIT_KEY] = clean;
    if ($('bookSubmitColor')) $('bookSubmitColor').value = clean;
    if ($('bookSubmitColorText') && document.activeElement !== $('bookSubmitColorText')) $('bookSubmitColorText').value = clean;
    queueUpdate({ webButtonColors: map });
  }

  function bindBookingPanel() {
    if ($('bookFormStyle')) {
      $('bookFormStyle').addEventListener('change', function () {
        if (!state.tenant) return;
        var style = $('bookFormStyle').value === 'guided' ? 'guided' : 'standard';
        queueUpdate({ bookingFormStyleId: style });
        if ($('bookFormStyleHint')) $('bookFormStyleHint').textContent = FORM_STYLE_HINT[style];
        syncBookFieldsSummary();
        if (state.booking.fieldsOpen) renderFieldsEditor();
      });
    }
    if ($('bookFieldsToggle')) {
      $('bookFieldsToggle').addEventListener('click', function () {
        state.booking.fieldsOpen = !state.booking.fieldsOpen;
        syncBookFieldsSummary();
        renderFieldsEditor();
      });
    }
    if ($('bookSubmitLabel')) {
      $('bookSubmitLabel').addEventListener('input', function () {
        if (!state.tenant) return;
        queueUpdate(setWebCopyOverride(BOOK_SUBMIT_KEY, $('bookSubmitLabel').value.trim()));
      });
    }
    if ($('bookSubmitColor')) {
      $('bookSubmitColor').addEventListener('input', function () {
        if ($('bookSubmitColorText')) $('bookSubmitColorText').value = $('bookSubmitColor').value.toUpperCase();
        applyBookButtonColor($('bookSubmitColor').value);
      });
    }
    if ($('bookSubmitColorText')) {
      $('bookSubmitColorText').addEventListener('change', function () {
        applyBookButtonColor($('bookSubmitColorText').value);
      });
    }
    if ($('addServiceBtn')) $('addServiceBtn').addEventListener('click', addService);
    if ($('addReviewBtn')) {
      $('addReviewBtn').addEventListener('click', function () {
        var list = reviewsForEdit();
        if (list.length >= 3) return;
        list.push({ quote: '', name: '', service: '' });
        commitReviews(list);
        renderReviews();
      });
    }
  }

  async function loadTenantForUser(user) {
    var userSnap = await db.collection('users').doc(user.uid).get();
    var userData = userSnap.exists ? userSnap.data() : {};
    var tenantId = userData.tenantId;
    if (!tenantId) { showGate('gateNoSite'); return; }
    var tenantSnap = await db.collection('tenants').doc(tenantId).get();
    if (!tenantSnap.exists) { showGate('gateNoSite'); return; }
    var tenant = tenantSnap.data() || {};
    tenant.id = tenantSnap.id;
    if (!(tenant.ownerUid === user.uid || userData.tenantId === tenantSnap.id)) {
      $('gateNoSiteMsg').textContent = 'This account can’t edit website design. Ask the business owner.';
      showGate('gateNoSite');
      return;
    }
    state.tenantId = tenantSnap.id;
    state.tenant = tenant;
    state.slug = tenant.slug || '';
    state.siteUrl = siteUrlForTenant(tenant);
    state.previewTry = 0;
    state.previewUrl = previewUrlForTenant(tenant);
    if (!state.siteUrl) { showGate('gateNoSite'); return; }

    if ($('shopTitle')) {
      $('shopTitle').textContent = tenant.displayName || state.slug || 'Site';
      $('shopTitle').title = state.siteUrl;
    }
    $('openLiveBtn').href = state.siteUrl;
    $('openLiveBtn').onclick = function () {
      // Locally, open the local site instead of production, and carry unpublished layouts along.
      if (!isLocalDesignShell() || !state.previewUrl) return;
      var layouts = (state.tenant && state.tenant.webSectionLayouts) || {};
      this.href = state.previewUrl + '?bk_layouts=' + encodeURIComponent(JSON.stringify(layouts));
    };
    syncPagePath();
    syncViewportLabel();
    setPanel(state.panel || 'pages');
    fillBrandKit();
    fillContentForm();
    renderHealth();
    renderPhotos();
    renderTemplates();
    updateHistoryButtons();
    loadBookingServices();
    showGate('designApp');
    requestAnimationFrame(function () { syncEditBar(); });
    loadPreview();
  }

  function wireUi() {
    bindBookingPanel();
    bindConfirmModal();
    if ($('sectionDoneBtn')) {
      $('sectionDoneBtn').addEventListener('click', function () {
        setPanel(state.returnPanel && state.returnPanel !== 'section' ? state.returnPanel : 'pages');
      });
    }
    document.querySelectorAll('.design-icon[data-panel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-panel');
        var body = document.querySelector('.design-body');
        if (name === state.panel && body && !body.classList.contains('is-panel-hidden')) {
          setPanelHidden(true);
          return;
        }
        setPanel(name);
      });
    });
    if ($('openTemplatesBtn')) {
      $('openTemplatesBtn').addEventListener('click', function () { setMode('templates'); });
    }
    if ($('closeTemplatesBtn')) {
      $('closeTemplatesBtn').addEventListener('click', function () { setMode('preview'); });
    }

    document.querySelectorAll('.design-nav-btn[data-path]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        if (ev.target.closest('.design-nav-check')) return;
        document.querySelectorAll('.design-nav-btn[data-path]').forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        state.path = btn.getAttribute('data-path') || '/';
        syncPagePath();
        setMode('preview');
        loadPreview();
      });
      btn.addEventListener('keydown', function (ev) {
        if (ev.target.closest('.design-nav-check')) return;
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        btn.click();
      });
    });

    document.querySelectorAll('.design-device button[data-device]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.design-device button[data-device]').forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        state.device = btn.getAttribute('data-device') || 'desktop';
        $('frameShell').setAttribute('data-device', state.device);
        syncViewportLabel();
      });
    });

    $('reloadPreviewBtn').addEventListener('click', loadPreview);
    $('saveBtn').addEventListener('click', savePending);

    // ── top tab strip ─────────────────────────────────────────────────────
    if ($('editModeBtn')) {
      $('editModeBtn').addEventListener('click', function () {
        state.editMode = !state.editMode;
        syncEditToggle();
        postEditMode();
      });
    }
    if ($('editBarChevron')) {
      var editBarDrag = null;
      var editBarGrip = $('editBarChevron');
      editBarGrip.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        var bar = $('editBar');
        var box = bar ? bar.getBoundingClientRect() : { left: ev.clientX, top: ev.clientY };
        editBarDrag = {
          x: ev.clientX,
          y: ev.clientY,
          dx: ev.clientX - box.left,
          dy: ev.clientY - box.top,
          moved: false,
          id: ev.pointerId
        };
        try { editBarGrip.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      });
      editBarGrip.addEventListener('pointermove', function (ev) {
        if (!editBarDrag || ev.pointerId !== editBarDrag.id) return;
        if (Math.abs(ev.clientX - editBarDrag.x) + Math.abs(ev.clientY - editBarDrag.y) > 6) editBarDrag.moved = true;
        if (!editBarDrag.moved) return;
        var host = $('workspacePreview');
        var bar = $('editBar');
        if (!host || !bar) return;
        var hostBox = host.getBoundingClientRect();
        var pos = clampEditBar(ev.clientX - hostBox.left - editBarDrag.dx, ev.clientY - hostBox.top - editBarDrag.dy);
        bar.style.left = pos.left + 'px';
        bar.style.top = pos.top + 'px';
        bar.style.right = 'auto';
        bar.style.bottom = 'auto';
        bar.style.transform = 'none';
      });
      editBarGrip.addEventListener('pointerup', function (ev) {
        if (!editBarDrag || ev.pointerId !== editBarDrag.id) return;
        var moved = editBarDrag.moved;
        editBarDrag = null;
        if (moved) rememberEditBarPos();
        else state.editBarCollapsed = !state.editBarCollapsed;
        persistEditBar();
        syncEditBar();
      });
    }
    window.addEventListener('resize', function () { applyEditBarPos(); });
    var frameCanvas = $('frameShell') && $('frameShell').parentNode;
    if (frameCanvas && window.ResizeObserver) {
      new ResizeObserver(function () { syncViewportLabel(); }).observe(frameCanvas);
    }
    if ($('editBarText')) {
      $('editBarText').addEventListener('input', function () {
        if (!state.selected || state.selected.kind !== 'text') return;
        var key = state.selected.key;
        var value = $('editBarText').value;
        state.selected.value = value;
        $('inspectorFieldInput').value = value;
        postToFrame('text-patch', { key: canonicalTextKey(key), value: value });
        if (key.indexOf('displayName') === 0) {
          postToFrame('text-patch', { key: key, value: value });
        }
      });
      $('editBarText').addEventListener('change', function () {
        if (!state.selected || state.selected.kind !== 'text') return;
        var updates = buildFieldUpdates(state.selected.key, $('editBarText').value);
        if (!updates || updates['__skip_' + state.selected.key] !== undefined) return;
        queueUpdate(updates);
      });
    }
    loadEditBarPrefs();
    syncEditBar();
    if ($('editBarTextTool')) {
      $('editBarTextTool').addEventListener('click', function () { setEditTool('text'); });
    }
    if ($('editBarColorTool')) {
      $('editBarColorTool').addEventListener('click', function () { setEditTool('background'); });
    }
    if ($('editBarWheel')) {
      function pickFromWheel(ev) {
        var hex = wheelHexFromEvent(ev);
        if (!hex) return;
        setPaintHex(hex, !!(state.selected && state.selected.kind === 'color'));
      }
      $('editBarWheel').addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0) return;
        pickFromWheel(ev);
        try { $('editBarWheel').setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      });
      $('editBarWheel').addEventListener('pointermove', function (ev) {
        if (!(ev.buttons & 1)) return;
        pickFromWheel(ev);
      });
    }
    document.addEventListener('pointermove', moveEditPointer);
    if ($('previewFrame')) {
      $('previewFrame').addEventListener('pointerenter', function () {
        var pointer = $('editPointer');
        if (pointer) pointer.hidden = true;
      });
    }

    document.querySelectorAll('.design-top-tab[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        document.querySelectorAll('.design-top-tab').forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        if (tab === 'templates') {
          setMode('templates');
        } else if (tab === 'editor') {
          setMode('preview');
          setPanel(state.panel || 'pages');
        }
      });
    });
    var doneBtn = $('doneBtn');
    if (doneBtn) {
      if (location.protocol === 'file:') doneBtn.setAttribute('href', 'app.html');
      else doneBtn.setAttribute('href', '/app');
      doneBtn.addEventListener('click', function (ev) {
        if (Object.keys(state.pending || {}).length === 0) return;
        if (!window.confirm('Leave Design without saving?')) ev.preventDefault();
      });
    }
    $('undoBtn').addEventListener('click', function () { undoChange(); });
    $('redoBtn').addEventListener('click', function () { redoChange(); });
    updateHistoryButtons();
    $('previewFrame').addEventListener('load', function () {
      setTimeout(enableBridgeWhenReady, 120);
    });
    window.addEventListener('message', onBridgeMessage);

    $('inspectorFieldInput').addEventListener('input', function () {
      if (!state.selected || state.selected.kind !== 'text') return;
      var key = state.selected.key;
      var value = $('inspectorFieldInput').value;
      state.selected.value = value;
      if ($('editBarText') && document.activeElement !== $('editBarText')) $('editBarText').value = value;
      postToFrame('text-patch', { key: canonicalTextKey(key), value: value });
      if (key.indexOf('displayName') === 0) {
        postToFrame('text-patch', { key: key, value: value });
      }
    });
    $('inspectorFieldInput').addEventListener('change', function () {
      if (!state.selected || state.selected.kind !== 'text') return;
      var updates = buildFieldUpdates(state.selected.key, $('inspectorFieldInput').value);
      if (!updates || updates['__skip_' + state.selected.key] !== undefined) return;
      queueUpdate(updates);
    });

    function applyInspectorColor(hex) {
      if (!state.selected || state.selected.kind !== 'color') return;
      hex = normalizeHex(hex, '#FFFFFF');
      $('inspectorColorInput').value = hex;
      $('inspectorColorText').value = hex;
      if ($('editBarColor')) $('editBarColor').value = hex;
      if ($('editBarHex') && document.activeElement !== $('editBarHex')) $('editBarHex').value = hex;
      state.paintHex = hex;
      if ($('sectionColor') && document.activeElement !== $('sectionColor')) $('sectionColor').value = hex;
      if ($('sectionColorText') && document.activeElement !== $('sectionColorText')) $('sectionColorText').value = hex;
      if (state.selected.surfaceKey) {
        var onlyMap = Object.assign({}, state.tenant.webSurfaceColors || {});
        onlyMap[state.selected.surfaceKey] = hex;
        queueUpdate({ webSurfaceColors: onlyMap });
        pushLivePreview();
        return;
      }
      if (state.selected.surface === 'card') return;
      var field = SURFACE_TO_FIELD[state.selected.surface] || 'backgroundColor';
      var patch = {};
      patch[field] = hex;
      if (state.selected.surfaceKey) {
        var map = Object.assign({}, state.tenant.webSurfaceColors || {});
        map[state.selected.surfaceKey] = hex;
        patch.webSurfaceColors = map;
      }
      queueUpdate(patch);
      pushLivePreview();
    }
    paintSelection = function (hex) { applyInspectorColor(hex); };
    $('inspectorColorInput').addEventListener('input', function () { applyInspectorColor($('inspectorColorInput').value); });
    $('inspectorColorText').addEventListener('change', function () { applyInspectorColor($('inspectorColorText').value); });
    if ($('editBarColor')) {
      $('editBarColor').addEventListener('input', function () { applyInspectorColor($('editBarColor').value); });
    }
    if ($('editBarHex')) {
      $('editBarHex').addEventListener('input', function () {
        var raw = $('editBarHex').value.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) {
          setPaintHex(raw, !!(state.selected && state.selected.kind === 'color'));
        }
      });
      $('editBarHex').addEventListener('change', function () {
        setPaintHex($('editBarHex').value, !!(state.selected && state.selected.kind === 'color'));
      });
    }

    $('inspectorUploadBtn').addEventListener('click', function () {
      if (!state.selected || state.selected.kind !== 'sheet') return;
      var target = uploadTargetFromKey(state.selected.key);
      if (!target) {
        alert('This photo type isn’t supported in the web editor yet.');
        return;
      }
      beginUpload(target);
    });

    bindColorPair('colorBackground', 'colorBackgroundText', 'backgroundColor');
    bindColorPair('colorText', 'colorTextText', 'textColor');
    bindColorPair('colorPrimary', 'colorPrimaryText', 'primaryColor');
    bindColorPair('colorCard', 'colorCardText', 'cardSurfaceColor');
    bindColorPair('colorFeatured', 'colorFeaturedText', 'featuredWorkBackgroundColor');
    bindColorPair('colorAbout', 'colorAboutText', 'aboutSectionBackgroundColor');

    function bindToggle(id, field) {
      $(id).addEventListener('change', function () {
        var patch = {};
        patch[field] = $(id).checked;
        queueUpdate(patch);
        loadPreview();
      });
    }
    bindToggle('toggleGalleryPage', 'showGalleryPage');
    bindToggle('toggleBookPage', 'showBookPage');
    bindToggle('toggleAboutPage', 'showAboutPage');
    bindToggle('toggleShop', 'shopEnabled');
    $('toggleTeamPage').addEventListener('change', function () {
      var on = $('toggleTeamPage').checked;
      queueUpdate({ showTeamPage: on, showMeetTheTeamOnHome: on });
      loadPreview();
    });

    $('announcementEnabled').addEventListener('change', function () {
      queueUpdate({ siteAnnouncementEnabled: $('announcementEnabled').checked });
      pushLivePreview();
    });
    $('announcementText').addEventListener('change', function () {
      queueUpdate({ siteAnnouncementText: $('announcementText').value });
      pushLivePreview();
    });
    $('seoTitle').addEventListener('change', function () {
      queueUpdate({ seoTitle: $('seoTitle').value });
      pushLivePreview();
    });
    $('seoDescription').addEventListener('change', function () {
      queueUpdate({ seoDescription: $('seoDescription').value });
      pushLivePreview();
    });

    function bindContent(id, field) {
      $(id).addEventListener('change', function () {
        var value = $(id).value;
        if (field === 'displayName') {
          var updates = buildFieldUpdates('displayName', value);
          if (updates) {
            queueUpdate(updates);
            postToFrame('text-patch', { key: 'wc.site.displayName', value: value });
            postToFrame('text-patch', { key: 'displayName', value: value });
          }
          return;
        }
        var patch = {};
        patch[field] = value;
        queueUpdate(patch);
        if (SITE_TEXT_FIELDS[field]) {
          postToFrame('text-patch', { key: field, value: value });
        }
      });
    }
    bindContent('contentDisplayName', 'displayName');
    bindContent('contentTagline', 'tagline');
    bindContent('contentAbout', 'aboutText');
    bindContent('contentPhone', 'contactPhone');
    bindContent('contentEmail', 'contactEmail');
    bindContent('contentAddress', 'contactAddress');
    bindContent('contentSuite', 'contactAddressSuite');

    $('uploadHeroBtn').addEventListener('click', function () { beginUpload({ type: 'hero' }); });
    $('addFeaturedBtn').addEventListener('click', function () { beginUpload({ type: 'featured', index: -1 }); });
    $('addGalleryBtn').addEventListener('click', function () { beginUpload({ type: 'gallery', index: -1 }); });
    $('uploadPhilosophyBtn').addEventListener('click', function () { beginUpload({ type: 'philosophy' }); });
    $('uploadBookCtaBtn').addEventListener('click', function () { beginUpload({ type: 'bookCta' }); });

    $('filePicker').addEventListener('change', async function () {
      var files = Array.prototype.slice.call($('filePicker').files || []);
      var batchTarget = state.uploadTarget;
      if (!files.length || !batchTarget) return;
      var aspect = 16 / 9;
      if (batchTarget.type === 'featured' || batchTarget.type === 'gallery') aspect = 1;
      if (batchTarget.type === 'philosophy' || batchTarget.type === 'bookCta') aspect = 4 / 3;
      var uploaded = 0;
      try {
        for (var i = 0; i < files.length; i++) {
          var target = batchTarget;
          if (batchTarget.type === 'gallery' || batchTarget.type === 'featured') {
            target = {
              type: batchTarget.type,
              index: batchTarget.index >= 0 && i === 0 ? batchTarget.index : -1
            };
          }
          state.uploadTarget = target;
              if (files.length > 1) {
            setStatus('Photo ' + (i + 1) + ' of ' + files.length + '…');
          }
          var blob;
          if (files.length > 1) {
            // Batch: auto-fill without modal, user can re-crop each tile individually later
            blob = await autoFillToBlob(files[i], aspect);
          } else {
            blob = await openCrop(files[i], aspect);
          }
          await handleCroppedUpload(blob, { clearTarget: false });
          uploaded++;
        }
        if (uploaded > 1) {
          setStatus(uploaded + ' photos uploaded', 'is-ok');
        }
      } catch (err) {
        if (!err || err.message !== 'cancelled') {
          console.error(err);
          alert((err && err.message) || 'Could not process photo');
        } else if (uploaded > 0) {
          setStatus(uploaded + ' photo' + (uploaded === 1 ? '' : 's') + ' uploaded', 'is-ok');
        }
      } finally {
        state.uploadTarget = null;
        $('filePicker').value = '';
      }
    });

    window.addEventListener('beforeunload', function (ev) {
      if (!state.dirty) return;
      ev.preventDefault();
      ev.returnValue = '';
    });
    document.addEventListener('keydown', function (ev) {
      var key = String(ev.key).toLowerCase();
      var meta = ev.metaKey || ev.ctrlKey;
      if (!meta) return;
      // Don't steal shortcuts while typing in inputs/textareas (except save)
      var tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
      var typing = tag === 'input' || tag === 'textarea' || (ev.target && ev.target.isContentEditable);
      if (key === 's') {
        ev.preventDefault();
        if (state.dirty) savePending();
        return;
      }
      if (typing) return;
      if (key === 'z' && ev.shiftKey) {
        ev.preventDefault();
        redoChange();
        return;
      }
      if (key === 'z') {
        ev.preventDefault();
        undoChange();
        return;
      }
      if (key === 'y') {
        ev.preventDefault();
        redoChange();
      }
    });
  }

  wireUi();

  auth.onAuthStateChanged(function (user) {
    if (!user) {
      showGate('gateLogin');
      return;
    }
    state.user = user;
    showGate('gateLoading');
    loadTenantForUser(user).catch(function (err) {
      console.error(err);
      $('gateNoSiteMsg').textContent = (err && err.message) || 'Could not load your website.';
      showGate('gateNoSite');
    });
  });
})();
