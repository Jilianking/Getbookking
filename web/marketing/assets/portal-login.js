/**
 * Shared login UX for marketing, admin, and beta portals (matches marketing login.html).
 */
(function (global) {
  function authErrorMessage(err) {
    var code = err && err.code ? err.code : "";
    if (
      code === "auth/user-not-found" ||
      code === "auth/wrong-password" ||
      code === "auth/invalid-credential"
    ) {
      return "Incorrect email or password.";
    }
    if (code === "auth/invalid-email") return "Enter a valid email address.";
    return err && err.message ? err.message : "Could not log in.";
  }

  function clearLoginFields(emailId, passwordId) {
    var emailEl = document.getElementById(emailId);
    var passEl = document.getElementById(passwordId);
    if (emailEl) emailEl.value = "";
    if (passEl) passEl.value = "";
  }

  function showPanel(panelId, visible) {
    var el = document.getElementById(panelId);
    if (!el) return;
    el.classList.toggle("hidden", !visible);
  }

  function setError(errorElId, msg) {
    var el = document.getElementById(errorElId);
    if (!el) return;
    if (el.hidden !== undefined) {
      el.hidden = !msg;
      el.textContent = msg || "";
      return;
    }
    el.textContent = msg || "";
    el.classList.toggle("visible", !!msg);
  }

  /**
   * @param {object} opts
   * @param {object} opts.auth
   * @param {string} opts.formId
   * @param {string} opts.signedInPanelId
   * @param {string} opts.formPanelId
   * @param {string} opts.signedInEmailId
   * @param {string} opts.switchBtnId
   * @param {string} opts.submitBtnId
   * @param {string} opts.errorElId
   * @param {string} opts.emailInputId
   * @param {string} opts.passwordInputId
   * @param {function} opts.getDestination
   * @param {function|null} opts.onVerify - (user) => Promise
   * @param {function} opts.formatVerifyError
   * @param {string} opts.continueBtnId
   * @param {function} opts.getContinueLabel
   * @param {boolean} [opts.autoRedirectWhenSignedIn]
   */
  function init(opts) {
    var auth = opts.auth;
    var verifying = false;

    function showLoginForm() {
      showPanel(opts.signedInPanelId, false);
      showPanel(opts.formPanelId, true);
    }

    function showSignedInPanel(email) {
      var emailEl = document.getElementById(opts.signedInEmailId);
      if (emailEl) emailEl.textContent = email;
      showPanel(opts.formPanelId, false);
      showPanel(opts.signedInPanelId, true);
      updateContinueLink();
    }

    function updateContinueLink() {
      var dest = opts.getDestination();
      var link = document.getElementById(opts.continueBtnId);
      if (link) {
        link.href = dest;
        if (opts.getContinueLabel) {
          link.textContent = opts.getContinueLabel(dest);
        }
      }
    }

    function verifyAndGo(user, fromContinue) {
      if (verifying) return Promise.resolve();
      verifying = true;
      setError(opts.errorElId, "");
      var submitBtn = document.getElementById(opts.submitBtnId);
      var continueBtn = document.getElementById(opts.continueBtnId);
      if (submitBtn) submitBtn.disabled = true;
      if (continueBtn && continueBtn.tagName === "BUTTON") continueBtn.disabled = true;

      var chain = Promise.resolve();
      if (opts.onVerify) {
        chain = chain.then(function () {
          return user.getIdToken(true);
        }).then(function () {
          return opts.onVerify(user);
        });
      }

      return chain
        .then(function () {
          global.location.href = opts.getDestination();
        })
        .catch(function (err) {
          verifying = false;
          if (submitBtn) submitBtn.disabled = false;
          if (continueBtn && continueBtn.tagName === "BUTTON") continueBtn.disabled = false;
          var msg = opts.formatVerifyError
            ? opts.formatVerifyError(err)
            : authErrorMessage(err);
          if (fromContinue) {
            showLoginForm();
          }
          setError(opts.errorElId, msg);
          return auth.signOut();
        });
    }

    document.getElementById(opts.switchBtnId).addEventListener("click", function () {
      auth.signOut().then(function () {
        clearLoginFields(opts.emailInputId, opts.passwordInputId);
        showLoginForm();
        setError(opts.errorElId, "");
      });
    });

    var continueEl = document.getElementById(opts.continueBtnId);
    if (continueEl && continueEl.tagName === "BUTTON") {
      continueEl.addEventListener("click", function () {
        var user = auth.currentUser;
        if (!user) {
          showLoginForm();
          return;
        }
        verifyAndGo(user, true);
      });
    } else if (continueEl) {
      continueEl.addEventListener("click", function (ev) {
        ev.preventDefault();
        var user = auth.currentUser;
        if (!user) {
          showLoginForm();
          return;
        }
        verifyAndGo(user, true);
      });
    }

    document.getElementById(opts.formId).addEventListener("submit", function (ev) {
      ev.preventDefault();
      var email = document.getElementById(opts.emailInputId).value.trim();
      var password = document.getElementById(opts.passwordInputId).value;
      var btn = document.getElementById(opts.submitBtnId);
      setError(opts.errorElId, "");
      btn.disabled = true;
      auth
        .signInWithEmailAndPassword(email, password)
        .then(function (cred) {
          return verifyAndGo(cred.user, false);
        })
        .catch(function (err) {
          btn.disabled = false;
          setError(opts.errorElId, authErrorMessage(err));
        });
    });

    auth.onAuthStateChanged(function (user) {
      if (user && user.email) {
        if (opts.autoRedirectWhenSignedIn) {
          var dest = opts.getDestination();
          var params = new URLSearchParams(global.location.search);
          if (params.get("next") && dest.indexOf("billing.html") !== -1) {
            global.location.replace(dest);
            return;
          }
        }
        showSignedInPanel(user.email);
      } else {
        showLoginForm();
      }
    });
  }

  global.PortalLogin = {
    init: init,
    authErrorMessage: authErrorMessage,
    clearLoginFields: clearLoginFields,
    setError: setError,
  };
})(window);
