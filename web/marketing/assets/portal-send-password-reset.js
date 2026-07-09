/**
 * Branded password reset via sendPasswordResetLink Cloud Function (Resend + custom handler).
 */
(function (global) {
  function callableMessage(err) {
    if (!err) return "Something went wrong. Please try again.";
    var details = err.details;
    if (typeof details === "string" && details.trim()) return details.trim();
    var msg = (err.message && String(err.message).trim()) || "";
    if (msg && msg.toLowerCase() !== "internal" && msg !== err.code) return msg;
    if (err.code === "functions/internal" || err.code === "internal") {
      return "Could not send reset email. Please try again.";
    }
    return msg || "Could not send reset email.";
  }

  function getFunctions() {
    if (!global.firebase || !global.firebase.apps.length) {
      throw new Error("Firebase is not initialized.");
    }
    return global.firebase.app().functions("us-central1");
  }

  function send(email, portal) {
    var trimmed = (email || "").toString().trim();
    if (!trimmed) {
      return Promise.reject(new Error("Enter your email address."));
    }
    return getFunctions()
      .httpsCallable("sendPasswordResetLink")({
        email: trimmed,
        portal: portal || "marketing",
      })
      .then(function () {
        return { ok: true };
      });
  }

  global.PortalSendPasswordReset = {
    send: send,
    callableMessage: callableMessage,
  };
})(window);
