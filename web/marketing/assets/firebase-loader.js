/**
 * Loads Firebase compat SDK from same-origin vendor files, with gstatic fallback.
 */
(function (global) {
  var VERSION = '10.7.1';
  var FILES = {
    app: 'firebase-app-compat.js',
    auth: 'firebase-auth-compat.js',
    functions: 'firebase-functions-compat.js',
    storage: 'firebase-storage-compat.js'
  };

  var loadPromise = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  function loadModule(name) {
    var file = FILES[name];
    if (!file) {
      return Promise.reject(new Error('Unknown Firebase module: ' + name));
    }
    var localSrc = '/assets/vendor/firebase/' + file;
    var cdnSrc = 'https://www.gstatic.com/firebasejs/' + VERSION + '/' + file;
    return loadScript(localSrc).catch(function () {
      return loadScript(cdnSrc);
    });
  }

  function load(modules) {
    if (loadPromise) return loadPromise;
    modules = modules || ['app', 'auth', 'functions'];
    loadPromise = modules.reduce(function (chain, mod) {
      return chain.then(function () { return loadModule(mod); });
    }, Promise.resolve()).then(function () {
      if (!global.firebase) {
        throw new Error(
          'Firebase SDK did not load. Disable ad blockers for getbookking.com or try another browser.'
        );
      }
    });
    return loadPromise;
  }

  global.BetaAdminFirebase = { load: load };
})(window);
