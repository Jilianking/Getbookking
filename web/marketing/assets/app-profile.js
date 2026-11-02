/**
 * Shop portal "Your website profile": a team member's own part of the shop's website — the
 * same screen as the iPhone app's Website profile. Bio needs "Edit public bio"; portfolio needs
 * "Edit portfolio" (both set by the owner). Saves through the same server functions as the app.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var MAX_PHOTOS = 24;
  var state = { session: null, me: null, wired: false, busy: false };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fns() {
    return firebase.app().functions(REGION);
  }

  function access() {
    return (state.session && state.session.access) || {};
  }

  function canBio() {
    return !!(state.session && (state.session.isOwner || access().canEditPublicBio));
  }

  function canPortfolio() {
    return !!(state.session && (state.session.isOwner || access().canEditPortfolio));
  }

  /** Shown in the menu only for team members the owner let edit something. */
  function allowed(session) {
    if (!session || session.isOwner) return false;
    var a = session.access || {};
    return !!(a.canEditPublicBio || a.canEditPortfolio);
  }

  function profileUrl() {
    var t = state.session.tenant || {};
    var slug = String(t.slug || "").toLowerCase();
    var ms = String((state.me && state.me.memberSlug) || "").toLowerCase();
    if (!slug) return "";
    return "https://" + slug + ".getbookking.com" + (ms ? "/team/" + ms : "/home");
  }

  function setMsg(id, text, ok) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
    el.classList.toggle("is-ok", !!ok);
  }

  function paint() {
    var host = $("profileBody");
    if (!host) return;
    var me = state.me;
    if (!me) {
      host.innerHTML = '<p class="app-empty">Loading your profile…</p>';
      return;
    }
    var url = profileUrl();
    var photos = Array.isArray(me.providerGalleryImages) ? me.providerGalleryImages : [];
    var html = '<div class="app-profile-grid">';
    if (canBio()) {
      html += '<article class="app-card app-profile-card"><div class="app-card-head"><h2>About you</h2>' +
        (url ? '<a class="app-btn app-btn--warm" href="' + esc(url) + '" target="_blank" rel="noopener">See your page</a>' : "") + "</div>" +
        '<div class="app-profile-body"><p class="app-hint">Shows on your page and team card on the shop\'s website.</p>' +
        '<textarea id="profileBio" rows="7" maxlength="2000" placeholder="A few lines about you, your style, and what you love doing.">' + esc(me.providerAboutText || "") + "</textarea>" +
        '<div class="app-profile-row"><span class="app-hint" id="profileBioCount"></span><button type="button" class="app-btn app-btn--primary" id="profileBioSave">Save bio</button></div>' +
        '<p class="app-sheet-error hidden" id="profileBioMsg"></p></div></article>';
    }
    if (canPortfolio()) {
      html += '<article class="app-card app-profile-card is-wide"><div class="app-card-head"><h2>Portfolio</h2><span class="app-chart-range">' +
        photos.length + " of " + MAX_PHOTOS + "</span></div>" +
        '<div class="app-profile-body"><p class="app-hint">Your work, shown on your page. Photos are saved as soon as you add or remove them.</p>' +
        '<div class="app-profile-photos">' + photos.map(function (u, i) {
          return '<figure><img src="' + esc(u) + '" alt="" loading="lazy"><button type="button" class="app-profile-remove" data-photo-remove="' + i + '" aria-label="Remove photo">×</button></figure>';
        }).join("") +
        (photos.length < MAX_PHOTOS ? '<label class="app-profile-add"><input type="file" accept="image/*" multiple id="profilePhotoInput"><span>+</span><strong>Add photos</strong></label>' : "") +
        "</div>" +
        '<p class="app-sheet-error hidden" id="profilePhotoMsg"></p></div></article>';
    }
    if (!canBio() && !canPortfolio()) {
      html += '<div class="app-req-empty"><strong>Nothing to edit yet</strong><span>Ask the owner to let you edit your bio or portfolio.</span></div>';
    }
    host.innerHTML = html + "</div>";
    countBio();
  }

  function countBio() {
    var t = $("profileBio");
    var c = $("profileBioCount");
    if (t && c) c.textContent = t.value.length + " / 2000";
  }

  function saveBio() {
    var t = $("profileBio");
    if (!t || state.busy) return;
    state.busy = true;
    var btn = $("profileBioSave");
    btn.disabled = true;
    fns().httpsCallable("updateMyPublicProfile")({ providerAboutText: t.value.trim() }).then(function (res) {
      var saved = (res && res.data && res.data.providerAboutText) || t.value.trim();
      state.me.providerAboutText = saved;
      setMsg("profileBioMsg", "Saved", true);
    }).catch(function (e) {
      setMsg("profileBioMsg", (e && e.message) || "Couldn't save your bio.", false);
    }).then(function () {
      state.busy = false;
      btn.disabled = false;
    });
  }

  /** Same size limits as the app: the long edge at most 1680px, saved as JPEG. */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1680 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("Couldn't read that photo.")); }, "image/jpeg", 0.82);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn't read that photo."));
      };
      img.src = url;
    });
  }

  function saveGallery(list) {
    return fns().httpsCallable("updateProviderGallery")({ providerGalleryImages: list }).then(function (res) {
      var saved = (res && res.data && res.data.providerGalleryImages) || list;
      state.me.providerGalleryImages = saved;
    });
  }

  function addPhotos(files) {
    if (state.busy || !files.length) return;
    var current = (state.me.providerGalleryImages || []).slice();
    var room = MAX_PHOTOS - current.length;
    var pick = Array.prototype.slice.call(files, 0, Math.max(0, room));
    if (!pick.length) return;
    state.busy = true;
    setMsg("profilePhotoMsg", "Uploading " + pick.length + (pick.length === 1 ? " photo…" : " photos…"), true);
    var s = state.session;
    var uploads = pick.map(function (f) {
      return shrink(f).then(function (blob) {
        var name = (global.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())) + ".jpg";
        var ref = firebase.storage().ref().child("tenants/" + s.tenantId + "/providers/" + s.user.uid + "/gallery/" + name);
        return ref.put(blob, { contentType: "image/jpeg" }).then(function () { return ref.getDownloadURL(); });
      });
    });
    Promise.all(uploads).then(function (urls) {
      return saveGallery(current.concat(urls));
    }).then(function () {
      state.busy = false;
      paint();
    }).catch(function (e) {
      state.busy = false;
      paint();
      setMsg("profilePhotoMsg", (e && e.message) || "Couldn't add those photos.", false);
    });
  }

  function removePhoto(i) {
    if (state.busy) return;
    var list = (state.me.providerGalleryImages || []).slice();
    list.splice(i, 1);
    state.busy = true;
    saveGallery(list).then(function () {
      state.busy = false;
      paint();
    }).catch(function (e) {
      state.busy = false;
      setMsg("profilePhotoMsg", (e && e.message) || "Couldn't remove that photo.", false);
    });
  }

  function wire() {
    if (state.wired) return;
    state.wired = true;
    var host = $("profileBody");
    host.addEventListener("click", function (ev) {
      if (ev.target.closest("#profileBioSave")) return saveBio();
      var rm = ev.target.closest("[data-photo-remove]");
      if (rm && global.confirm("Remove this photo from your portfolio?")) removePhoto(Number(rm.getAttribute("data-photo-remove")));
    });
    host.addEventListener("input", function (ev) {
      if (ev.target.id === "profileBio") {
        countBio();
        setMsg("profileBioMsg", "");
      }
    });
    host.addEventListener("change", function (ev) {
      if (ev.target.id === "profilePhotoInput") addPhotos(ev.target.files || []);
    });
  }

  function load(session) {
    state.session = session;
    wire();
    paint();
    // Fresh copy of this person's own team record (bio, portfolio, page address).
    return fns().httpsCallable("listTenantMembers")({}).then(function (res) {
      var members = (res && res.data && res.data.members) || [];
      state.me = members.filter(function (m) { return m.uid === session.user.uid; })[0] || { providerGalleryImages: [] };
    }).catch(function () {
      state.me = (session.members || []).filter(function (m) { return m.uid === session.user.uid; })[0] || { providerGalleryImages: [] };
    }).then(paint);
  }

  global.ShopAppProfile = { load: load, allowed: allowed };
})(window);
