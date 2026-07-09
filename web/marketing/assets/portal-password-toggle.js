/**
 * Show/hide password toggles for auth forms.
 */
(function (global) {
  var EYE =
    '<svg class="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>' +
    '<svg class="icon-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a20.77 20.77 0 0 1 5.06-6.24"></path>' +
    '<path d="M9.9 4.24A10.94 10.94 0 0 1 12 5c7 0 11 7 11 7a20.75 20.75 0 0 1-3.16 4.19"></path>' +
    '<line x1="1" y1="1" x2="23" y2="23"></line></svg>';

  function bindPasswordToggles(root) {
    (root || document).querySelectorAll("[data-password-toggle]").forEach(function (btn) {
      if (btn.dataset.bound === "1") return;
      btn.dataset.bound = "1";
      if (!btn.innerHTML.trim()) {
        btn.innerHTML = EYE;
      }
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-password-toggle");
        var input = document.getElementById(id);
        if (!input) return;
        var show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.classList.toggle("is-visible", show);
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
      });
    });
  }

  global.PortalPasswordToggle = {
    bind: bindPasswordToggles,
  };
})(window);
