/**
 * Beta tester portal helpers (parallel to admin.js, separate namespace).
 */
(function (global) {
  var BETA_BASE = '/beta';
  var ALLOWED_NEXT = [BETA_BASE, BETA_BASE + '/report-bug'];
  var MAX_ATTACHMENTS = 3;
  var MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
  var ALLOWED_ATTACHMENT_TYPES = /^(image\/|video\/|application\/pdf)/;

  var FALLBACK_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyB9DwVkkCM-0cpYhkWRnTfScHIRNIDyJ3g',
    authDomain: 'test-app-96812.firebaseapp.com',
    projectId: 'test-app-96812',
    storageBucket: 'test-app-96812.firebasestorage.app',
    messagingSenderId: '729589639948',
    appId: '1:729589639948:web:af6eb6c640f3364c6d7729',
    measurementId: 'G-L01T86TY3K'
  };

  function ensureFirebaseConfig() {
    if (!global.firebaseConfig) {
      global.firebaseConfig = FALLBACK_FIREBASE_CONFIG;
    }
    return global.firebaseConfig;
  }

  function initFirebase() {
    ensureFirebaseConfig();
    if (!global.firebase) {
      throw new Error(
        'Firebase SDK did not load. Disable ad blockers for getbookking.com or try another browser.'
      );
    }
    if (!global.firebase.apps.length) {
      global.firebase.initializeApp(global.firebaseConfig);
    }
    return {
      auth: global.firebase.auth(),
      fns: global.firebase.app().functions('us-central1'),
      storage: global.firebase.storage()
    };
  }

  function isAllowedNext(path) {
    if (!path || path.indexOf('://') !== -1 || path.indexOf('..') !== -1) return false;
    return ALLOWED_NEXT.indexOf(path) !== -1;
  }

  function loginUrl(nextPath) {
    var next = (nextPath || '').trim();
    var path;
    if (!next || !isAllowedNext(next)) {
      path = BETA_BASE + '/login';
    } else {
      path = BETA_BASE + '/login?next=' + encodeURIComponent(next);
    }
    if (global.PortalOrigins && !global.PortalOrigins.isDevHost()) {
      return global.PortalOrigins.absoluteUrl('beta', path);
    }
    return path;
  }

  function postLoginDestination() {
    var params = new URLSearchParams(global.location.search);
    var next = (params.get('next') || '').trim();
    if (isAllowedNext(next)) return next;
    return BETA_BASE;
  }

  function callableMessage(err) {
    if (err && err.message) return err.message;
    return 'Something went wrong. Please try again.';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function callCallable(fb, user, functionName, data) {
    var authUser = user || (fb && fb.auth && fb.auth.currentUser);
    if (!authUser) {
      return Promise.reject(new Error('Sign in to continue.'));
    }
    return authUser.getIdToken(true).then(function () {
      return fb.fns.httpsCallable(functionName)(data || {});
    });
  }

  function sanitizeFileName(name) {
    return String(name || 'attachment')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 120) || 'attachment';
  }

  function validateAttachmentFile(file) {
    if (!file) return 'Invalid file.';
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return '"' + file.name + '" is too large (max 25 MB).';
    }
    var type = (file.type || '').toLowerCase();
    if (!ALLOWED_ATTACHMENT_TYPES.test(type)) {
      return '"' + file.name + '" must be an image, video, or PDF.';
    }
    return null;
  }

  function uploadBugAttachments(fb, user, files) {
    var list = Array.prototype.slice.call(files || [], 0, MAX_ATTACHMENTS);
    if (!list.length) return Promise.resolve([]);

    var uid = user.uid;
    var batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    return Promise.all(list.map(function (file, index) {
      var err = validateAttachmentFile(file);
      if (err) return Promise.reject(new Error(err));

      var ref = fb.storage.ref().child(
        'betaBugAttachments/' + uid + '/' + batchId + '_' + index + '/' + sanitizeFileName(file.name)
      );
      return ref.put(file, { contentType: file.type || 'application/octet-stream' })
        .then(function () { return ref.getDownloadURL(); })
        .then(function (url) {
          return {
            url: url,
            path: ref.fullPath,
            name: file.name,
            contentType: file.type || '',
            size: file.size
          };
        });
    }));
  }

  function bootFirebase() {
    var loader = global.BetaAdminFirebase;
    if (!loader) {
      return Promise.reject(new Error('Firebase loader script is missing.'));
    }
    return loader.load(['app', 'auth', 'functions', 'storage']).then(function () {
      return { fb: initFirebase() };
    });
  }

  function requireTester() {
    return bootFirebase().then(function (ctx) {
      return new Promise(function (resolve, reject) {
        var verified = false;
        var done = false;

        function finish(err, result) {
          if (done) return;
          done = true;
          if (err) reject(err);
          else resolve(result);
        }

        ctx.fb.auth.onAuthStateChanged(function (user) {
          if (!user) {
            if (verified) {
              global.location.replace(loginUrl(global.location.pathname));
              return;
            }
            global.location.replace(loginUrl(global.location.pathname));
            return;
          }

          if (verified) return;

          user.getIdToken(true).then(function () {
            return ctx.fb.fns.httpsCallable('getBetaTesterPortal')();
          }).then(function (res) {
            verified = true;
            finish(null, { fb: ctx.fb, user: user, portal: res.data || {} });
          }).catch(function (err) {
            var msg = callableMessage(err);
            ctx.fb.auth.signOut().finally(function () {
              var dest = loginUrl(global.location.pathname);
              var sep = dest.indexOf('?') === -1 ? '?' : '&';
              global.location.replace(dest + sep + 'error=' + encodeURIComponent(msg));
            });
          });
        }, function (err) {
          finish(err || new Error('Could not verify sign-in.'));
        });
      });
    });
  }

  function detectDeviceInfo() {
    var params = new URLSearchParams(global.location.search);
    var ua = global.navigator.userAgent || '';
    var ios = (params.get('ios') || '').trim();
    var model = (params.get('device') || '').trim();
    var appVersion = (params.get('app') || '').trim();
    var build = (params.get('build') || '').trim();

    if (!ios) {
      var iosMatch = ua.match(/OS (\d+[._]\d+(?:[._]\d+)?)/);
      if (iosMatch) ios = iosMatch[1].replace(/_/g, '.');
    }
    if (!model && /iPhone/.test(ua)) model = 'iPhone';
    if (!model && /iPad/.test(ua)) model = 'iPad';

    return {
      deviceModel: model,
      iosVersion: ios,
      appVersion: appVersion,
      buildNumber: build
    };
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  global.BetaPortal = {
    BETA_BASE: BETA_BASE,
    MAX_ATTACHMENTS: MAX_ATTACHMENTS,
    bootFirebase: bootFirebase,
    requireTester: requireTester,
    initFirebase: initFirebase,
    loginUrl: loginUrl,
    postLoginDestination: postLoginDestination,
    callCallable: callCallable,
    uploadBugAttachments: uploadBugAttachments,
    validateAttachmentFile: validateAttachmentFile,
    callableMessage: callableMessage,
    escapeHtml: escapeHtml,
    detectDeviceInfo: detectDeviceInfo,
    formatFileSize: formatFileSize
  };
})(window);
