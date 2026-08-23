/**
 * Booking site boot helpers: load only the active theme fonts/CSS, and defer
 * Stripe / Firebase Storage until checkout or file upload needs them.
 */
(function (w) {
  var scriptPromises = {};
  var fontPromises = {};
  var cssPromises = {};

  function loadScript(src) {
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
    return scriptPromises[src];
  }

  function loadStylesheet(href, id) {
    if (document.getElementById(id)) return Promise.resolve();
    return new Promise(function (resolve) {
      var l = document.createElement('link');
      l.id = id;
      l.rel = 'stylesheet';
      l.href = href;
      l.onload = function () { resolve(); };
      l.onerror = function () { resolve(); };
      document.head.appendChild(l);
    });
  }

  var FONT_HREF = {
    classic:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Kanit:wght@400;600;700&family=Unbounded:wght@300;500;700;900&display=swap',
    charter:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Kanit:wght@400;600;700&display=swap',
    luxe:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&family=Libre+Baskerville:wght@400;700&display=swap',
    blade:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Barlow:ital,wght@0,300;0,400;0,500;1,300&family=Bebas+Neue&family=Anton&display=swap',
    stonecut:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Syne:wght@300;400;500&family=Unbounded:wght@300;500;700;900&family=DM+Serif+Display:ital@0;1&display=swap',
    studio12:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Jost:wght@200;300;400;500&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&display=swap',
  };

  function themeFontKey(themeId) {
    var id = String(themeId || '').toLowerCase();
    if (id === 'luxe-v1' || id === 'luxe') return 'luxe';
    if (id === 'blade-v1' || id === 'blade') return 'blade';
    if (id === 'stonecut-v1' || id === 'stonecut') return 'stonecut';
    if (id === 'studio-12-v1' || id === 'studio12' || id === 'studio-12') return 'studio12';
    if (id === 'charter-v1' || id === 'charter') return 'charter';
    return 'classic';
  }

  function ensureThemeFonts(themeId) {
    var key = themeFontKey(themeId);
    if (fontPromises[key]) return fontPromises[key];
    fontPromises[key] = loadStylesheet(FONT_HREF[key], 'bk-theme-fonts-' + key);
    return fontPromises[key];
  }

  var THEME_CSS = {
    studio12: '/css/studio12-theme.css?v=20260822g',
    blade: '/css/blade-theme.css?v=20260812m',
    luxe: '/css/luxe-theme.css?v=20260822a',
    stonecut: '/css/stonecut-theme.css?v=20260822h',
    classic: '/css/classic-theme.css?v=20260812m',
    charter: '/css/charter-theme.css?v=20260823aa',
  };

  function ensureThemeCss(themeId) {
    var key = themeFontKey(themeId);
    var href = THEME_CSS[key];
    if (!href) return Promise.resolve();
    if (cssPromises[key]) return cssPromises[key];
    cssPromises[key] = loadStylesheet(href, 'bk-theme-css-' + key);
    return cssPromises[key];
  }

  function ensureStripe() {
    if (typeof w.Stripe === 'function') return Promise.resolve();
    return loadScript('https://js.stripe.com/v3/');
  }

  function ensureFirebaseStorage() {
    if (typeof firebase !== 'undefined' && typeof firebase.storage === 'function') {
      try {
        return Promise.resolve(firebase.storage());
      } catch (e) {
        /* fall through and load the script */
      }
    }
    return loadScript(
      'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage-compat.js'
    ).then(function () {
      return firebase.storage();
    });
  }

  w.BKSitePerf = {
    ensureThemeFonts: ensureThemeFonts,
    ensureThemeCss: ensureThemeCss,
    ensureStripe: ensureStripe,
    ensureFirebaseStorage: ensureFirebaseStorage,
    themeFontKey: themeFontKey,
  };
})(window);
