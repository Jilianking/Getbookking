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
          '">' +
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

  /** Products are added and edited in the website editor's Shop section. */
  function addTile() {
    return '<a class="app-product-add" href="/design">' +
      '<span aria-hidden="true">+</span><strong>Add product</strong><em>Opens the website editor</em></a>';
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
          $("shopProductEmpty").textContent =
            (err && err.message) || "Could not load the shop.";
        }
      });
  }

  function attach(session) {
    state.session = session;
    if (state.wired) return;
    state.wired = true;
    document.querySelectorAll("[data-shop-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTab(btn.getAttribute("data-shop-tab"));
      });
    });
  }

  global.ShopAppShop = { attach: attach, load: load };
})(window);
