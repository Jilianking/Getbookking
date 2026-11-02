/**
 * Shop portal Shop: tenants/{id}/products and shopOrders (same docs as iPhone Shop).
 */
(function (global) {
  "use strict";

  var state = {
    session: null,
    products: [],
    orders: [],
    tab: "catalog",
    wired: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s || "").replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return "$" + v.toFixed(2);
  }

  function cents(n) {
    return money((Number(n) || 0) / 100);
  }

  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === "function") return v.toDate();
    if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
    if (v instanceof Date) return v;
    return null;
  }

  function mapProduct(doc) {
    var d = doc.data() || {};
    return {
      id: doc.id,
      name: d.name || "Product",
      category: d.category || "",
      price: typeof d.price === "number" ? d.price : parseFloat(d.price) || 0,
      salePrice: d.salePrice != null ? Number(d.salePrice) : null,
      imageUrl: d.imageUrl || "",
      isActive: d.isActive !== false,
      description: d.description || "",
      weightOz: Number(d.weightOz) > 0 ? Number(d.weightOz) : 0,
      lengthIn: Number(d.lengthIn) > 0 ? Number(d.lengthIn) : 0,
      widthIn: Number(d.widthIn) > 0 ? Number(d.widthIn) : 0,
      heightIn: Number(d.heightIn) > 0 ? Number(d.heightIn) : 0,
      sortOrder: typeof d.sortOrder === "number" ? d.sortOrder : 999999,
    };
  }

  function orderTotal(d) {
    if (typeof d.totalCents === "number") return d.totalCents;
    return Number(d.subtotalCents || 0) + Number(d.taxCents || 0) + Number(d.surchargeCents || 0);
  }

  function mapOrder(doc) {
    var d = doc.data() || {};
    return {
      id: doc.id,
      status: String(d.status || "paid").replace(/_/g, " "),
      name: d.customerName || "Guest",
      totalCents: orderTotal(d),
      createdAt: toDate(d.createdAt || d.paidAt),
    };
  }

  function setTab(tab) {
    state.tab = tab === "orders" ? "orders" : "catalog";
    $("shopTabCatalog").classList.toggle("is-on", state.tab === "catalog");
    $("shopTabOrders").classList.toggle("is-on", state.tab === "orders");
    $("shopCatalogPanel").classList.toggle("hidden", state.tab !== "catalog");
    $("shopOrdersPanel").classList.toggle("hidden", state.tab !== "orders");
  }

  function renderStats() {
    $("shopStatProducts").textContent = String(state.products.length);
    $("shopStatOrders").textContent = String(state.orders.length);
    var revenue = state.orders.reduce(function (sum, o) {
      return sum + (o.totalCents || 0);
    }, 0);
    $("shopStatRevenue").textContent = state.orders.length ? cents(revenue) : "$0.00";
    // Revenue is for people who can see earnings.
    var revTile = $("shopStatRevenue") && $("shopStatRevenue").parentNode;
    if (revTile && global.ShopAppAccess) revTile.classList.toggle("hidden", !ShopAppAccess.can(state.session, "earnings"));
  }

  function renderCatalog() {
    var grid = $("shopProductGrid");
    var empty = $("shopProductEmpty");
    if (!grid || !empty) return;
    if (!state.products.length) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    var list = state.products.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    grid.innerHTML = list
      .map(function (p) {
        var price =
          p.salePrice != null && p.salePrice < p.price
            ? '<span class="app-product-sale">' +
              esc(money(p.salePrice)) +
              "</span> <s>" +
              esc(money(p.price)) +
              "</s>"
            : esc(money(p.price));
        var img = p.imageUrl
          ? '<img src="' + esc(p.imageUrl) + '" alt="" />'
          : '<div class="app-product-ph" aria-hidden="true">' +
            esc(p.name.charAt(0).toUpperCase()) +
            "</div>";
        return (
          '<article class="app-product-card' +
          (p.isActive ? "" : " is-off") +
          '" role="button" tabindex="0" data-shop-edit="' + esc(p.id) + '" aria-label="Edit ' + esc(p.name) + '">' +
          img +
          "<div>" +
          "<strong>" +
          esc(p.name) +
          "</strong>" +
          (p.category ? "<span>" + esc(p.category) + "</span>" : "") +
          '<p class="app-product-price">' +
          price +
          "</p>" +
          (p.isActive ? "" : '<em>Hidden</em>') +
          "</div></article>"
        );
      })
      .join("") + addTile();
  }

  function addTile() {
    return '<button type="button" class="app-product-add" data-shop-add>' +
      '<span aria-hidden="true">+</span><strong>Add product</strong><em>Shows in your website\'s shop</em></button>';
  }

  /* ── Add / edit sheet (same fields the iPhone app and Website builder save) ── */

  var sheet = { id: null, photo: null, preview: "", busy: false };
  var NUM_FIELDS = [["shopWeight", "weightOz"], ["shopLength", "lengthIn"], ["shopWidth", "widthIn"], ["shopHeight", "heightIn"]];

  function productsRef() {
    return firebase.firestore().collection("tenants").doc(state.session.tenantId).collection("products");
  }

  function num(v) {
    var n = parseFloat(String(v || "").replace(/[^0-9.]/g, ""));
    return n > 0 ? Math.round(n * 100) / 100 : 0;
  }

  function showVal(n) {
    return n > 0 ? String(n) : "";
  }

  function setError(text) {
    var el = $("shopError");
    el.textContent = text || "";
    el.classList.toggle("hidden", !text);
  }

  function paintPhoto(url) {
    $("shopPhotoBox").innerHTML = url ? '<img src="' + esc(url) + '" alt="" />' : '<span aria-hidden="true">Photo</span>';
    $("shopPhotoLabel").textContent = url ? "Replace photo" : "Add photo";
  }

  function openSheet(id) {
    var p = id ? state.products.filter(function (x) { return x.id === id; })[0] : null;
    sheet.id = p ? p.id : null;
    sheet.photo = null;
    if (sheet.preview) URL.revokeObjectURL(sheet.preview);
    sheet.preview = "";
    $("shopSheetTitle").textContent = p ? "Edit product" : "New product";
    $("shopProdName").value = p ? p.name : "";
    $("shopPrice").value = p ? showVal(p.price) : "";
    $("shopSale").value = p && p.salePrice > 0 ? showVal(p.salePrice) : "";
    $("shopCategory").value = p ? p.category : "";
    $("shopDesc").value = p ? p.description : "";
    NUM_FIELDS.forEach(function (f) { $(f[0]).value = p ? showVal(p[f[1]]) : ""; });
    $("shopVisible").checked = p ? p.isActive : true;
    $("shopDelete").classList.toggle("hidden", !p);
    $("shopSave").textContent = p ? "Save" : "Add to shop";
    $("shopSave").disabled = false;
    paintPhoto(p ? p.imageUrl : "");
    setError("");
    $("shopSheet").classList.remove("hidden");
    $("shopSheetScrim").classList.remove("hidden");
    $("shopProdName").focus();
  }

  function closeSheet() {
    if (sheet.busy) return;
    $("shopSheet").classList.add("hidden");
    $("shopSheetScrim").classList.add("hidden");
    if (sheet.preview) URL.revokeObjectURL(sheet.preview);
    sheet.preview = "";
    sheet.photo = null;
  }

  /** Long edge at most 1680px, saved as JPEG (same as the app). */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1680 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
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

  function uploadPhoto(file) {
    return shrink(file).then(function (blob) {
      var name = (global.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + ".jpg";
      var ref = firebase.storage().ref().child("tenants/" + state.session.tenantId + "/products/" + name);
      return ref.put(blob, { contentType: "image/jpeg" }).then(function () { return ref.getDownloadURL(); });
    });
  }

  function save(ev) {
    if (ev) ev.preventDefault();
    if (sheet.busy) return;
    var name = $("shopProdName").value.trim();
    var price = num($("shopPrice").value);
    var sale = num($("shopSale").value);
    var problem = !name ? "Give the product a name."
      : !(price > 0) ? "Enter a price."
      : sale > 0 && sale >= price ? "The sale price needs to be lower than the price."
      : "";
    if (problem) return setError(problem);
    setError("");
    sheet.busy = true;
    var btn = $("shopSave");
    btn.disabled = true;
    btn.textContent = sheet.id ? "Saving…" : "Adding…";
    var editing = sheet.id;
    var current = editing ? state.products.filter(function (x) { return x.id === editing; })[0] : null;
    var del = firebase.firestore.FieldValue.delete();
    (sheet.photo ? uploadPhoto(sheet.photo) : Promise.resolve(current ? current.imageUrl : ""))
      .then(function (imageUrl) {
        var desc = $("shopDesc").value.trim();
        var data = {
          name: name,
          price: price,
          category: $("shopCategory").value.trim(),
          imageUrl: imageUrl || "",
          isActive: $("shopVisible").checked,
        };
        var extra = { salePrice: sale };
        NUM_FIELDS.forEach(function (f) { extra[f[1]] = num($(f[0]).value); });
        if (editing) {
          data.description = desc ? desc : del;
          Object.keys(extra).forEach(function (k) { data[k] = extra[k] > 0 ? extra[k] : del; });
          return productsRef().doc(editing).set(data, { merge: true });
        }
        if (desc) data.description = desc;
        Object.keys(extra).forEach(function (k) { if (extra[k] > 0) data[k] = extra[k]; });
        var maxSort = state.products.reduce(function (m, x) { return x.sortOrder < 999999 ? Math.max(m, x.sortOrder) : m; }, -1);
        data.sortOrder = maxSort + 1;
        return productsRef().add(data);
      })
      .then(function () {
        sheet.busy = false;
        closeSheet();
        return load(state.session);
      })
      .catch(function (err) {
        sheet.busy = false;
        btn.disabled = false;
        btn.textContent = editing ? "Save" : "Add to shop";
        setError((err && err.message) || "Couldn't save the product. Try again.");
      });
  }

  function remove() {
    if (sheet.busy || !sheet.id) return;
    if (!global.confirm("Delete this product? It comes off your website. To keep it but hide it, turn off Visible on site instead.")) return;
    sheet.busy = true;
    $("shopDelete").disabled = true;
    productsRef().doc(sheet.id).delete()
      .then(function () {
        sheet.busy = false;
        $("shopDelete").disabled = false;
        closeSheet();
        return load(state.session);
      })
      .catch(function (err) {
        sheet.busy = false;
        $("shopDelete").disabled = false;
        setError((err && err.message) || "Couldn't delete the product.");
      });
  }

  function wireSheet() {
    var view = $("viewShop");
    view.addEventListener("click", function (ev) {
      if (ev.target.closest("[data-shop-add]")) return openSheet(null);
      var card = ev.target.closest("[data-shop-edit]");
      if (card) openSheet(card.getAttribute("data-shop-edit"));
    });
    view.addEventListener("keydown", function (ev) {
      var card = ev.target.closest && ev.target.closest("[data-shop-edit]");
      if (card && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        openSheet(card.getAttribute("data-shop-edit"));
      }
    });
    ["shopSheetClose", "shopCancel", "shopSheetScrim"].forEach(function (id) {
      $(id).addEventListener("click", closeSheet);
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !$("shopSheet").classList.contains("hidden")) closeSheet();
    });
    $("shopForm").addEventListener("submit", save);
    $("shopDelete").addEventListener("click", remove);
    $("shopPhotoInput").addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!f) return;
      if (sheet.preview) URL.revokeObjectURL(sheet.preview);
      sheet.photo = f;
      sheet.preview = URL.createObjectURL(f);
      paintPhoto(sheet.preview);
    });
  }

  function renderOrders() {
    var list = $("shopOrderList");
    var empty = $("shopOrderEmpty");
    if (!list || !empty) return;
    if (!state.orders.length) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    var rows = state.orders.slice().sort(function (a, b) {
      return (b.createdAt ? b.createdAt.getTime() : 0) - (a.createdAt ? a.createdAt.getTime() : 0);
    });
    list.innerHTML = rows
      .map(function (o) {
        var when = o.createdAt
          ? o.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "";
        return (
          '<div class="app-row">' +
          '<span class="app-row-copy"><strong>' +
          esc(o.name) +
          "</strong><span>" +
          esc(o.status) +
          (when ? " · " + when : "") +
          "</span></span>" +
          '<span class="app-pay-amt is-credit">' +
          esc(cents(o.totalCents)) +
          "</span></div>"
        );
      })
      .join("");
  }

  function render() {
    renderStats();
    renderCatalog();
    renderOrders();
  }

  function load(session) {
    state.session = session;
    if (!session || !session.tenantId) return;
    var col = firebase.firestore().collection("tenants").doc(session.tenantId);
    return Promise.all([
      col.collection("products").get(),
      col.collection("shopOrders").limit(100).get(),
    ])
      .then(function (snaps) {
        state.products = snaps[0].docs.map(mapProduct);
        state.orders = snaps[1].docs.map(mapOrder);
        render();
      })
      .catch(function (err) {
        state.products = [];
        state.orders = [];
        render();
        if ($("shopProductEmpty")) {
          $("shopProductEmpty").classList.remove("hidden");
          $("shopProductEmpty").querySelector("span").textContent =
            (err && err.message) || "Could not load the shop.";
        }
      });
  }

  function attach(session) {
    state.session = session;
    if (state.wired) return;
    state.wired = true;
    wireSheet();
    document.querySelectorAll("[data-shop-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTab(btn.getAttribute("data-shop-tab"));
      });
    });
  }

  global.ShopAppShop = { attach: attach, load: load };
})(window);
