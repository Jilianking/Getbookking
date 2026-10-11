/* Statements that run when the script loads, in their original order. Keep the order. */

if (/(?:^|[?&])bk_embed=1(?:&|$)/.test(location.search || '')) {
  document.documentElement.classList.add('bk-marketing-embed');
}

if (/(?:^|[?&])bk_capture=1(?:&|$)/.test(location.search || '')) {
  document.documentElement.classList.add('bk-capture-mode');
}

if (/(?:^|[?&])bk_design=1(?:&|$)/.test(location.search || '')) {
  document.documentElement.classList.add('bk-design-mode');
}

if (typeof firebase === 'undefined' || typeof firebaseConfig === 'undefined') {
  document.getElementById('root').innerHTML = '<div class="container"><div class="card"><p class="error">Firebase failed to load.</p></div></div>';
  return;
}

try { firebase.initializeApp(firebaseConfig); } catch (e) {
  document.getElementById('root').innerHTML = '<div class="container"><div class="card"><p class="error">Firebase init failed.</p></div></div>';
  return;
}

firebase.auth().signInAnonymously().catch(function(err) {
  console.warn('Anonymous sign-in failed (Storage uploads may fail):', err);
});

const db = firebase.firestore();

const functions = firebase.app().functions('us-central1');

/** Supports subdomain (`{tenant}.getbookking.com/home`, `{tenant}.getbooking.com/home`), path (`/tenant/home`), team member (`/team/maya`, `/team/maya/book`). */
var RESERVED_TENANT_PAGES = { book: 1, gallery: 1, shop: 1, about: 1, team: 1, home: 1, join: 1, charters: 1, 'how-it-works': 1 };

window.__bkApplyCharterHeroPhoto = function() {
  var url = window.__bkNativeHeroImageUrl || '';
  applyCharterHeroPhoto({ heroImageUrl: url });
  var hero = document.querySelector('.charter-hero');
  if (hero && typeof paintCharterHeroSurface === 'function') {
    var col = (window.__bkCachedWebSurfaceColors || {})['charter.hero'];
    paintCharterHeroSurface(hero, { heroImageUrl: url }, col, null);
  }
};

window.__bkApplyPreviewColorPatch = applyPreviewColorPatch;

window.__bkApplyWebSurfaceColors = applyWebSurfaceColors;

window.__bkApplyWebButtonColors = applyWebButtonColors;

window.__bkApplyWebTextStyles = applyWebTextStyles;

var BK_LAYOUT_SLOTS = ['header', 'hero', 'gallery', 'services', 'shop', 'about', 'team', 'footer'];

// Extra per-section settings stored in the same map as `<slot>Align`.
var BK_LAYOUT_PROPS = ['Align'];

window.__bkApplySectionLayouts = applySectionLayouts;

/**
 * Intentional blank for optional dedicated site-copy fields.
 * ZWSP is invisible if an older page ever prints the raw value; `__blank__` is the legacy form.
 */
var SITE_TEXT_BLANK = '\u200B';

var SITE_TEXT_BLANK_LEGACY = '__blank__';

var s12ClayEmStyle = 'font-style:italic;color:var(--s12-clay);font-family:\'Cormorant Garamond\',serif';

var BOOK_PRIVACY_URL = 'https://getbookking.com/privacy.html';

var BOOK_TERMS_URL = 'https://getbookking.com/terms.html';

/** Known WebTheme ids. Design editor passes bk_web_theme so the preview does not wait on publicSites. */
var BK_PREVIEW_WEB_THEME_IDS = [
  'luxe-v1', 'blade-v1', 'stonecut-v1', 'studio-12-v1',
  'hair-salon-v1', 'barber-shop-v1', 'tattoo-studio-v1', 'nail-salon-v1',
  'custom-standard', 'charter-v1'
];

var CHARTER_OCCUPANCY_TTL_MS = 30000;

var CHARTER_OCCUPANCY_POLL_MS = 10000;

/** Matches iOS BookingRequestDetailModel.displayLabels (lowercase keys). */
var FORM_FIELD_DISPLAY_LABELS = {
  placement: 'Placement',
  size: 'Size',
  style: 'Style',
  description: 'Description',
  referenceimages: 'Reference photos',
  hairtype: 'Hair type',
  stylepreference: 'Style preference',
  visittype: 'Visit type',
  fadeorstyle: 'Fade / style',
  facialhair: 'Facial hair',
  cutdetails: 'What do you want done?',
  scalpsensitivity: 'Scalp / skin sensitivity',
  colorhistory: 'Color history',
  hairtexture: 'Hair texture',
  designpreference: 'Design preference',
  nailtype: 'Nail type',
  design: 'Design',
  issuetype: 'Issue type',
  propertytype: 'Property type',
  preferredcontact: 'Preferred contact',
  attachments: 'Attachments',
  address: 'Service address',
  skintone: 'Skin tone',
  allergies: 'Allergies',
  urgency: 'Urgency',
  name: 'Full Name',
  email: 'Email',
  phone: 'Phone',
  notes: 'Notes',
  preferreddays: 'Preferred days',
  preferredtime: 'Preferred time',
  preferredtimeofday: 'Preferred time'
};

var STUDIO12_MIDDLE_DOT_SEP = ' · ';

var classicMobileCartMq = window.matchMedia('(max-width: 768px)');

var bkShopCartPlacementListenerBound = false;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
