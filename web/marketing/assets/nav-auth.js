(function () {
  var IDLE_MS = 15 * 60 * 1000;
  var LAST_KEY = "bk_last_activity";

  function touchActivity() {
    localStorage.setItem(LAST_KEY, String(Date.now()));
  }

  function clearActivity() {
    localStorage.removeItem(LAST_KEY);
  }

  function isIdleExpired() {
    var last = parseInt(localStorage.getItem(LAST_KEY) || "0", 10);
    return last > 0 && Date.now() - last > IDLE_MS;
  }

  function displayNameFromUser(user) {
    if (!user) return "Account";
    if (user.displayName) {
      var first = user.displayName.trim().split(/\s+/)[0];
      if (first) return first;
    }
    if (user.email) {
      var local = user.email.split("@")[0];
      return local.charAt(0).toUpperCase() + local.slice(1);
    }
    return "Account";
  }

  function initialFromUser(user) {
    if (!user) return "?";
    if (user.displayName) return user.displayName.trim().charAt(0).toUpperCase();
    if (user.email) return user.email.charAt(0).toUpperCase();
    return "?";
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle("nav-auth-hidden", hidden);
  }

  function closeAccountMenu() {
    document.querySelectorAll(".nav-account-wrap.is-open").forEach(function (wrap) {
      wrap.classList.remove("is-open");
      var btn = wrap.querySelector(".nav-account-btn");
      var menu = wrap.querySelector(".nav-account-menu");
      if (btn) btn.setAttribute("aria-expanded", "false");
      if (menu) menu.hidden = true;
    });
  }

  function bindAccountDropdown() {
    document.querySelectorAll(".nav-account-wrap").forEach(function (wrap) {
      if (wrap.dataset.bound) return;
      wrap.dataset.bound = "1";
      var btn = wrap.querySelector(".nav-account-btn");
      var menu = wrap.querySelector(".nav-account-menu");
      if (!btn || !menu) return;

      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var open = wrap.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        menu.hidden = !open;
        if (open) {
          document.querySelectorAll(".nav-account-wrap.is-open").forEach(function (other) {
            if (other === wrap) return;
            other.classList.remove("is-open");
            var otherBtn = other.querySelector(".nav-account-btn");
            var otherMenu = other.querySelector(".nav-account-menu");
            if (otherBtn) otherBtn.setAttribute("aria-expanded", "false");
            if (otherMenu) otherMenu.hidden = true;
          });
        }
      });
    });

    if (!document.body.dataset.accountMenuBound) {
      document.body.dataset.accountMenuBound = "1";
      document.addEventListener("click", closeAccountMenu);
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") closeAccountMenu();
      });
    }
  }

  function updateNavUI(user) {
    var loggedIn = !!user;
    var name = displayNameFromUser(user);
    var email = user && user.email ? user.email : "";
    var initial = initialFromUser(user);

    if (!loggedIn) closeAccountMenu();

    document.querySelectorAll(".nav-auth-login").forEach(function (el) {
      setHidden(el, loggedIn);
    });
    document.querySelectorAll(".nav-auth-signup").forEach(function (el) {
      setHidden(el, loggedIn);
    });
    document.querySelectorAll(".nav-auth-account").forEach(function (el) {
      setHidden(el, !loggedIn);
      var btn = el.querySelector(".nav-account-btn");
      if (btn && loggedIn) {
        btn.setAttribute("aria-label", "Account menu — " + (email || name));
      }
    });
    document.querySelectorAll(".nav-auth-avatar").forEach(function (el) {
      el.textContent = initial;
    });
    document.querySelectorAll(".nav-auth-name").forEach(function (el) {
      el.textContent = loggedIn ? name : "Account";
    });
    document.querySelectorAll(".nav-auth-login-item").forEach(function (el) {
      setHidden(el, loggedIn);
    });
    document.querySelectorAll(".nav-auth-signup-item").forEach(function (el) {
      setHidden(el, loggedIn);
    });
    document.querySelectorAll(".nav-auth-account-item").forEach(function (el) {
      setHidden(el, !loggedIn);
    });
    document.querySelectorAll(".nav-auth-signout-item").forEach(function (el) {
      setHidden(el, !loggedIn);
    });
  }

  function bindSignOut(auth) {
    document.querySelectorAll(".nav-auth-signout").forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = "1";
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        closeAccountMenu();
        auth.signOut().then(function () {
          clearActivity();
          window.location.href = "index.html";
        });
      });
    });
  }

  function getFirebaseConfig() {
    if (window.firebaseConfig) return window.firebaseConfig;
    if (typeof firebaseConfig !== "undefined") return firebaseConfig;
    return null;
  }

  function init() {
    var config = getFirebaseConfig();
    if (typeof firebase === "undefined" || !config) return;
    if (!firebase.apps.length) firebase.initializeApp(config);
    var auth = firebase.auth();

    bindAccountDropdown();

    ["click", "keydown", "scroll", "mousemove", "touchstart"].forEach(function (ev) {
      document.addEventListener(ev, function () {
        if (auth.currentUser) touchActivity();
      }, { passive: true });
    });

    setInterval(function () {
      if (auth.currentUser && isIdleExpired()) {
        auth.signOut().then(function () {
          clearActivity();
          updateNavUI(null);
          if (window.location.pathname.indexOf("account.html") !== -1) {
            window.location.replace("login.html?timeout=1");
          }
        });
      }
    }, 60000);

    auth.onAuthStateChanged(function (user) {
      if (user && isIdleExpired()) {
        auth.signOut();
        clearActivity();
        updateNavUI(null);
        return;
      }
      if (user) touchActivity();
      else clearActivity();
      updateNavUI(user);
      bindSignOut(auth);
      bindAccountDropdown();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
