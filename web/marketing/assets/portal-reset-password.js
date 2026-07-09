/**
 * Branded Firebase password reset handler (oob link from email).
 * Shared across marketing, admin, and beta portals.
 */
(function (global) {
  var MIN_PASSWORD_LENGTH = 6;

  function parseParams() {
    var search = new URLSearchParams(global.location.search);
    var hash = global.location.hash.replace(/^#/, "");
    var hashParams = hash ? new URLSearchParams(hash) : null;
    function get(key) {
      var fromSearch = search.get(key);
      if (fromSearch) return fromSearch;
      return hashParams ? hashParams.get(key) : null;
    }
    return {
      mode: (get("mode") || "").trim(),
      oobCode: (get("oobCode") || "").trim(),
      continueUrl: (get("continueUrl") || "").trim(),
    };
  }

  function detectPortal(pathname, continueUrl) {
    var path = (pathname || global.location.pathname || "").toLowerCase();
    var cont = (continueUrl || "").toLowerCase();
    if (path.indexOf("/admin") === 0 || cont.indexOf("/admin") !== -1) return "admin";
    if (path.indexOf("/beta") === 0 || cont.indexOf("/beta") !== -1) return "beta";
    return "marketing";
  }

  function loginPath(portal) {
    if (portal === "admin") return "/admin/login";
    if (portal === "beta") return "/beta/login";
    return "/login.html";
  }

  function loginUrl(portal, continueUrl) {
    if (continueUrl && continueUrl.indexOf("://") !== -1) {
      try {
        var parsed = new URL(continueUrl);
        if (
          parsed.pathname.indexOf("/admin") === 0 ||
          parsed.pathname.indexOf("/beta") === 0 ||
          parsed.pathname.indexOf("/login") !== -1
        ) {
          return continueUrl;
        }
      } catch (err) {
        /* fall through */
      }
    }
    if (global.PortalOrigins && !global.PortalOrigins.isDevHost()) {
      return global.PortalOrigins.absoluteUrl(portal, loginPath(portal));
    }
    return loginPath(portal);
  }

  function authErrorMessage(err) {
    var code = err && err.code ? err.code : "";
    if (code === "auth/expired-action-code") {
      return "This reset link has expired. Request a new one from the sign-in page.";
    }
    if (code === "auth/invalid-action-code") {
      return "This reset link is invalid or was already used.";
    }
    if (code === "auth/weak-password") {
      return "Choose a stronger password (at least " + MIN_PASSWORD_LENGTH + " characters).";
    }
    return (err && err.message) || "Could not reset password.";
  }

  function setVisible(id, visible) {
    var el = document.getElementById(id);
    if (el) el.hidden = !visible;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text || "";
  }

  function bootAuth() {
    if (global.BetaAdmin && global.BetaAdmin.boot) {
      return global.BetaAdmin.boot(null).then(function (ctx) {
        return ctx.fb.auth;
      });
    }
    if (global.BetaPortal && global.BetaPortal.bootFirebase) {
      return global.BetaPortal.bootFirebase().then(function (ctx) {
        return ctx.fb.auth;
      });
    }
    if (!global.firebase) {
      return Promise.reject(new Error("Firebase did not load."));
    }
    if (!global.firebase.apps.length) {
      global.firebase.initializeApp(global.firebaseConfig);
    }
    return Promise.resolve(global.firebase.auth());
  }

  function init(opts) {
    opts = opts || {};
    var params = parseParams();
    var portal =
      opts.defaultPortal ||
      detectPortal(global.location.pathname, params.continueUrl);
    var backUrl = loginUrl(portal, params.continueUrl);

    var pill = document.getElementById("portalPill");
    if (pill) {
      if (portal === "admin") {
        pill.textContent = "Admin";
        pill.hidden = false;
      } else if (portal === "beta") {
        pill.textContent = "Beta";
        pill.hidden = false;
      } else {
        pill.hidden = true;
      }
    }

    ["backToLogin", "invalidBackLink"].forEach(function (id) {
      var link = document.getElementById(id);
      if (link) link.setAttribute("href", backUrl);
    });

    if (params.mode && params.mode !== "resetPassword") {
      setVisible("loadingPanel", false);
      setVisible("invalidPanel", true);
      setText("invalidMessage", "This link is not valid for password reset.");
      return;
    }

    if (!params.oobCode) {
      setVisible("loadingPanel", false);
      setVisible("invalidPanel", true);
      setText(
        "invalidMessage",
        "Missing reset code. Open the link from your email or request a new reset."
      );
      return;
    }

    var emailEl = document.getElementById("emailDisplay");
    var form = document.getElementById("resetPasswordForm");
    var submitBtn = document.getElementById("submitBtn");
    var errorEl = document.getElementById("resetError");
    var successEl = document.getElementById("resetSuccess");
    var passwordInput = document.getElementById("newPassword");
    var confirmInput = document.getElementById("confirmPassword");

    function showError(msg) {
      if (!errorEl) return;
      errorEl.hidden = !msg;
      errorEl.textContent = msg || "";
      if (msg && successEl) successEl.hidden = true;
    }

    bootAuth()
      .then(function (auth) {
        return auth.verifyPasswordResetCode(params.oobCode).then(function (email) {
          if (emailEl) emailEl.textContent = email;
          setVisible("loadingPanel", false);
          setVisible("formPanel", true);
          if (global.PortalPasswordToggle) global.PortalPasswordToggle.bind();
          return auth;
        });
      })
      .catch(function (err) {
        setVisible("loadingPanel", false);
        setVisible("invalidPanel", true);
        setText("invalidMessage", authErrorMessage(err));
      });

    if (!form) return;

    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var next = (passwordInput && passwordInput.value) || "";
      var confirm = (confirmInput && confirmInput.value) || "";
      showError("");

      if (next.length < MIN_PASSWORD_LENGTH) {
        showError("Password must be at least " + MIN_PASSWORD_LENGTH + " characters.");
        return;
      }
      if (next !== confirm) {
        showError("Passwords do not match.");
        return;
      }

      submitBtn.disabled = true;
      bootAuth()
        .then(function (auth) {
          return auth.confirmPasswordReset(params.oobCode, next);
        })
        .then(function () {
          setVisible("formPanel", false);
          setVisible("successPanel", true);
          setTimeout(function () {
            global.location.href = backUrl;
          }, 1800);
        })
        .catch(function (err) {
          submitBtn.disabled = false;
          showError(authErrorMessage(err));
        });
    });
  }

  global.PortalResetPassword = {
    init: init,
    detectPortal: detectPortal,
    loginUrl: loginUrl,
  };
})(window);
