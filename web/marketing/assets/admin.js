/**
 * Shared beta admin portal helpers.
 */
(function (global) {
  var ADMIN_BASE = '/admin';

  var NAV_ITEMS = {
    beta: [
      { id: 'requests', href: ADMIN_BASE + '/requests', label: 'Requests', badgeKey: 'pending' },
      { id: 'bugs', href: ADMIN_BASE + '/bugs', label: 'Bug reports', badgeKey: 'openBugs' },
      { id: 'reports', href: ADMIN_BASE + '/reports', label: 'Weekly reports' }
    ],
    app: [
      { id: 'testflight', href: ADMIN_BASE + '/testflight', label: 'TestFlight' },
      { id: 'settings', href: ADMIN_BASE + '/settings', label: 'Settings' }
    ]
  };

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
      fns: global.firebase.app().functions('us-central1')
    };
  }

  function boot(activeId) {
    var loader = global.BetaAdminFirebase;
    if (!loader) {
      return Promise.reject(new Error('Firebase loader script is missing.'));
    }
    return loader.load().then(function () {
      if (activeId) {
        mountShell(activeId);
        return requireAdmin(activeId);
      }
      return { fb: initFirebase() };
    });
  }

  function loginUrl(nextPath) {
    var next = (nextPath || '').trim();
    var path;
    if (!next) {
      path = ADMIN_BASE + '/login';
    } else if (next.indexOf('/') === 0) {
      path = ADMIN_BASE + '/login?next=' + encodeURIComponent(next);
    } else {
      path =
        ADMIN_BASE +
        '/login?next=' +
        encodeURIComponent(ADMIN_BASE + '/' + next.replace(/\.html$/, ''));
    }
    if (global.PortalOrigins && !global.PortalOrigins.isDevHost()) {
      return global.PortalOrigins.absoluteUrl('admin', path);
    }
    return path;
  }

  function callableMessage(err) {
    if (err && err.message) return err.message;
    return 'Something went wrong. Please try again.';
  }

  /** Refresh ID token, then invoke a Cloud Function (avoids stale-session unauthenticated errors). */
  function callCallable(fb, user, functionName, data) {
    var authUser = user || (fb && fb.auth && fb.auth.currentUser);
    if (!authUser) {
      return Promise.reject(new Error('Sign in to continue.'));
    }
    return authUser.getIdToken(true).then(function () {
      return fb.fns.httpsCallable(functionName)(data || {});
    });
  }

  function initials(firstName, lastName, email) {
    var a = (firstName || '').charAt(0);
    var b = (lastName || '').charAt(0);
    var combo = (a + b).toUpperCase();
    if (combo.trim()) return combo;
    return ((email || '?').charAt(0) || '?').toUpperCase();
  }

  function displayName(firstName, lastName) {
    var fn = (firstName || '').trim();
    var ln = (lastName || '').trim();
    if (fn && ln) return fn + ' ' + ln.charAt(0) + '.';
    return fn || ln || 'Unknown';
  }

  function timeAgo(value) {
    if (!value) return '—';
    var ms;
    if (value.toDate) ms = value.toDate().getTime();
    else if (value.seconds) ms = value.seconds * 1000;
    else ms = new Date(value).getTime();
    if (!ms || Number.isNaN(ms)) return '—';
    var diff = Date.now() - ms;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    return days + 'd ago';
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderSidebar(activeId, badges) {
    badges = badges || {};
    function link(item) {
      var badge = item.badgeKey && badges[item.badgeKey]
        ? '<span class="admin-badge">' + badges[item.badgeKey] + '</span>'
        : '';
      return '<a href="' + item.href + '" class="' + (item.id === activeId ? 'is-active' : '') + '">' +
        '<span>' + escapeHtml(item.label) + '</span>' + badge + '</a>';
    }
    return '' +
      '<aside class="admin-sidebar">' +
        '<div class="admin-brand">' +
          '<img src="/assets/brand/logo-dark-128.png?v=12" alt="" width="36" height="36" />' +
          '<div><div class="admin-brand-text">Bookking</div></div>' +
          '<span class="admin-pill">Admin</span>' +
        '</div>' +
        '<div><div class="admin-nav-group-label">BETA</div><nav class="admin-nav">' +
          NAV_ITEMS.beta.map(link).join('') +
        '</nav></div>' +
        '<div><div class="admin-nav-group-label">APP</div><nav class="admin-nav">' +
          NAV_ITEMS.app.map(link).join('') +
        '</nav></div>' +
        '<div class="admin-sidebar-foot">' +
          '<div id="adminUserEmail"></div>' +
          '<button type="button" id="adminSignOutBtn">Sign out</button>' +
        '</div>' +
      '</aside>';
  }

  function mountShell(activeId) {
    var shell = document.getElementById('adminShell');
    if (!shell) return null;
    shell.innerHTML = renderSidebar(activeId, window.__adminBadges || {}) + '<main class="admin-main" id="adminMain"><div class="admin-loading">Loading…</div></main>';
    var signOut = document.getElementById('adminSignOutBtn');
    if (signOut) {
      signOut.addEventListener('click', function () {
        initFirebase().auth.signOut().then(function () {
          location.href = loginUrl();
        });
      });
    }
    return document.getElementById('adminMain');
  }

  function requireAdmin(activeId) {
    var fb = initFirebase();
    var main = document.getElementById('adminMain');
    if (main) {
      main.innerHTML = '<div class="admin-loading">Checking access…</div>';
    }

    return new Promise(function (resolve, reject) {
      var verified = false;
      var done = false;

      function finish(err, result) {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve(result);
      }

      fb.auth.onAuthStateChanged(function (user) {
        if (!user) {
          if (verified) {
            location.replace(loginUrl(ADMIN_BASE + '/' + activeId));
            return;
          }
          if (main) {
            main.innerHTML = '<div class="admin-loading">Redirecting to sign in…</div>';
          }
          location.replace(loginUrl(ADMIN_BASE + '/' + activeId));
          return;
        }

        if (verified) return;

        var emailEl = document.getElementById('adminUserEmail');
        if (emailEl) emailEl.textContent = user.email || '';

        if (main) {
          main.innerHTML = '<div class="admin-loading">Verifying admin access…</div>';
        }

        user.getIdToken(true).then(function () {
          return fb.fns.httpsCallable('assertBetaPlatformAdmin')();
        }).then(function () {
          verified = true;
          finish(null, { fb: fb, user: user });
        }).catch(function (err) {
          var msg = callableMessage(err);
          fb.auth.signOut().finally(function () {
            var dest = loginUrl(ADMIN_BASE + '/' + activeId);
            var sep = dest.indexOf('?') === -1 ? '?' : '&';
            global.location.replace(dest + sep + 'error=' + encodeURIComponent(msg));
          });
        });
      }, function (err) {
        finish(err || new Error('Could not verify sign-in.'));
      });
    });
  }

  function showAdminError(message) {
    var main = document.getElementById('adminMain');
    if (!main) return;
    var el = document.createElement('div');
    el.className = 'admin-error';
    el.textContent = message;
    main.prepend(el);
  }

  function downloadCsv(filename, rows) {
    var csv = rows.map(function (row) {
      return row.map(function (cell) {
        var s = String(cell == null ? '' : cell);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  global.BetaAdmin = {
    ADMIN_BASE: ADMIN_BASE,
    ensureFirebaseConfig: ensureFirebaseConfig,
    initFirebase: initFirebase,
    boot: boot,
    loginUrl: loginUrl,
    callCallable: callCallable,
    callableMessage: callableMessage,
    initials: initials,
    displayName: displayName,
    timeAgo: timeAgo,
    escapeHtml: escapeHtml,
    renderSidebar: renderSidebar,
    mountShell: mountShell,
    requireAdmin: requireAdmin,
    showAdminError: showAdminError,
    downloadCsv: downloadCsv
  };
})(window);
