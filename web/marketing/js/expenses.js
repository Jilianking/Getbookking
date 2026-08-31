/**
 * Expenses & tax deductions section for account.html.
 * Mirrors the iOS ExpensesViewModel: manual expenses are read/written directly
 * from Firestore (tenants/{tenantId}/expenses — client-writable per firestore.rules,
 * same as customers/shopOrders), and Stripe processing fees are merged in at read
 * time from the existing getConnectBalanceTransactions callable — never stored.
 */
(function () {
  var CATEGORIES = [
    ["supplies", "Supplies"],
    ["equipment", "Equipment"],
    ["software_subscriptions", "Software & Subscriptions"],
    ["advertising_marketing", "Advertising & Marketing"],
    ["travel", "Travel"],
    ["meals", "Meals"],
    ["rent_utilities", "Rent & Utilities"],
    ["insurance", "Insurance"],
    ["professional_services", "Professional Services"],
    ["contract_labor", "Contract Labor"],
    ["vehicle_mileage", "Vehicle & Mileage"],
    ["education_training", "Education & Training"],
    ["other", "Other"],
  ];
  var CATEGORY_LABELS = {};
  CATEGORIES.forEach(function (c) { CATEGORY_LABELS[c[0]] = c[1]; });

  var state = {
    firestore: null,
    storage: null,
    fns: null,
    tenantId: null,
    rows: [],
    editingExpenseId: null,
    pendingReceiptDataUrl: null,
    pendingReceiptBlob: null,
  };

  function $(id) { return document.getElementById(id); }

  function generateId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function formatCurrency(cents) {
    return "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function dateInputValue(date) {
    var d = date instanceof Date ? date : new Date(date);
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }

  function defaultRangeStart() {
    var d = new Date();
    d.setMonth(d.getMonth() - 1);
    return d;
  }

  async function init(firebaseApp, auth, fns, user) {
    if (!user) return;
    state.firestore = firebase.firestore();
    state.storage = firebase.storage();
    state.fns = fns;

    populateCategorySelect();

    if (!$("expensesRangeStart").value) $("expensesRangeStart").value = dateInputValue(defaultRangeStart());
    if (!$("expensesRangeEnd").value) $("expensesRangeEnd").value = dateInputValue(new Date());

    try {
      var userDoc = await state.firestore.collection("users").doc(user.uid).get();
      var tenantId = userDoc.exists ? userDoc.data().tenantId : null;
      if (!tenantId) {
        showError("No business account linked to this login.");
        return;
      }
      state.tenantId = tenantId;
    } catch (err) {
      showError("Couldn't load your account.");
      return;
    }

    wireEvents();
    await loadAndRender();
  }

  function populateCategorySelect() {
    var select = $("expenseCategory");
    select.innerHTML = "";
    CATEGORIES.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c[0];
      opt.textContent = c[1];
      select.appendChild(opt);
    });
  }

  function wireEvents() {
    $("expensesApplyRange").addEventListener("click", function () { loadAndRender(); });
    $("expensesAddBtn").addEventListener("click", function () { openForm(null); });
    $("expensesExportBtn").addEventListener("click", exportCsv);
    $("expenseFormCancel").addEventListener("click", function () { $("expenseFormDialog").close(); });
    $("expenseForm").addEventListener("submit", onFormSubmit);
    $("expenseReceiptFile").addEventListener("change", onReceiptFileChange);
    $("expenseAutoFillBtn").addEventListener("click", onAutoFillClick);
  }

  function showError(msg) {
    var el = $("expensesError");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function clearError() {
    $("expensesError").classList.add("hidden");
  }

  async function loadAndRender() {
    clearError();
    $("expensesEmptyState").textContent = "Loading…";
    $("expensesEmptyState").classList.remove("hidden");

    var startDate = new Date($("expensesRangeStart").value + "T00:00:00");
    var endDate = new Date($("expensesRangeEnd").value + "T23:59:59");

    var manualRows = [];
    try {
      var snap = await state.firestore
        .collection("tenants").doc(state.tenantId).collection("expenses")
        .where("date", ">=", startDate)
        .where("date", "<=", endDate)
        .get();
      snap.forEach(function (doc) {
        var d = doc.data();
        manualRows.push({
          id: doc.id,
          amountCents: d.amountCents || 0,
          category: d.category || "other",
          categoryLabel: CATEGORY_LABELS[d.category] || "Other",
          vendor: d.vendor || "",
          date: d.date && d.date.toDate ? d.date.toDate() : new Date(d.date),
          note: d.note || "",
          receiptImageUrl: d.receiptImageUrl || null,
          sourceLabel: "Manual",
          isVirtual: false,
        });
      });
    } catch (err) {
      showError("Couldn't load expenses.");
    }

    var feeRows = await loadStripeFeeRows(startDate, endDate);
    state.rows = manualRows.concat(feeRows).sort(function (a, b) { return b.date - a.date; });
    render();
  }

  async function loadStripeFeeRows(startDate, endDate) {
    try {
      var result = await state.fns.httpsCallable("getConnectBalanceTransactions")({
        startTimestampSeconds: Math.floor(startDate.getTime() / 1000),
        endTimestampSeconds: Math.floor(endDate.getTime() / 1000),
        limit: 100,
      });
      var list = (result.data && result.data.transactions) || [];
      var rows = [];
      list.forEach(function (t) {
        if ((t.type || "").toLowerCase() !== "charge") return;
        var feeCents = t.fee || 0;
        if (feeCents <= 0) return;
        if (!t.created) return;
        rows.push({
          id: "stripe-fee-" + (t.id || Math.random()),
          amountCents: feeCents,
          category: "bank_merchant_fees",
          categoryLabel: "Payment Processing Fees",
          vendor: "Stripe",
          date: new Date(t.created * 1000),
          note: t.description || "",
          receiptImageUrl: null,
          sourceLabel: "Stripe (auto)",
          isVirtual: true,
        });
      });
      return rows;
    } catch (err) {
      return [];
    }
  }

  function render() {
    var totalCents = state.rows.reduce(function (sum, r) { return sum + r.amountCents; }, 0);
    $("expensesTotalLabel").textContent = "Total deductible: " + formatCurrency(totalCents);

    var byCategory = {};
    state.rows.forEach(function (r) {
      byCategory[r.categoryLabel] = (byCategory[r.categoryLabel] || 0) + r.amountCents;
    });
    var catContainer = $("expensesCategoryTotals");
    catContainer.innerHTML = "";
    Object.keys(byCategory).sort(function (a, b) { return byCategory[b] - byCategory[a]; }).forEach(function (label) {
      var row = document.createElement("div");
      row.className = "acct-expenses-category-row";
      row.innerHTML = "<span>" + escapeHtml(label) + "</span><span>" + formatCurrency(byCategory[label]) + "</span>";
      catContainer.appendChild(row);
    });

    var listEl = $("expensesList");
    listEl.innerHTML = "";
    if (state.rows.length === 0) {
      var empty = document.createElement("p");
      empty.className = "acct-expenses-empty";
      empty.textContent = "No expenses logged for this range.";
      listEl.appendChild(empty);
      return;
    }
    state.rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "acct-expenses-row";
      if (!r.isVirtual) {
        row.style.cursor = "pointer";
        row.addEventListener("click", function () { openForm(r); });
      }
      row.innerHTML =
        "<span>" +
        "<strong>" + escapeHtml(r.vendor || r.categoryLabel) + "</strong>" +
        "<div class=\"acct-expenses-row-meta\">" + escapeHtml(r.categoryLabel) + " · " + escapeHtml(r.sourceLabel) + "</div>" +
        "</span><span>" + formatCurrency(r.amountCents) + "</span>";
      listEl.appendChild(row);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function openForm(row) {
    $("expenseFormError").classList.add("hidden");
    $("expenseOcrStatus").classList.add("hidden");
    state.pendingReceiptDataUrl = null;
    state.pendingReceiptBlob = null;
    $("expenseReceiptFile").value = "";
    $("expenseAutoFillBtn").classList.add("hidden");

    if (row) {
      state.editingExpenseId = row.id;
      $("expenseFormTitle").textContent = "Edit expense";
      $("expenseAmount").value = (row.amountCents / 100).toFixed(2);
      $("expenseCategory").value = row.category;
      $("expenseVendor").value = row.vendor;
      $("expenseDate").value = dateInputValue(row.date);
      $("expenseNote").value = row.note;
    } else {
      state.editingExpenseId = null;
      $("expenseFormTitle").textContent = "Add expense";
      $("expenseAmount").value = "";
      $("expenseCategory").value = "other";
      $("expenseVendor").value = "";
      $("expenseDate").value = dateInputValue(new Date());
      $("expenseNote").value = "";
    }
    $("expenseFormDialog").showModal();
  }

  /// Attaches the photo only — does not call the (paid) OCR function. The user
  /// can type the expense in by hand, or click "Auto-fill from photo" separately
  /// to trigger a scan on demand.
  function onReceiptFileChange(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) {
      state.pendingReceiptBlob = null;
      $("expenseAutoFillBtn").classList.add("hidden");
      return;
    }
    state.pendingReceiptBlob = file;
    $("expenseAutoFillBtn").classList.remove("hidden");
  }

  async function onAutoFillClick() {
    var file = state.pendingReceiptBlob;
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      var base64 = String(reader.result).split(",")[1];
      $("expenseOcrStatus").textContent = "Reading receipt…";
      $("expenseOcrStatus").classList.remove("hidden");
      $("expenseAutoFillBtn").disabled = true;
      try {
        var result = await state.fns.httpsCallable("extractReceiptData")({
          imageBase64: base64,
          mimeType: file.type || "image/jpeg",
        });
        var data = result.data || {};
        var filledAny = false;
        if (data.amountCents) { $("expenseAmount").value = (data.amountCents / 100).toFixed(2); filledAny = true; }
        if (data.date) { $("expenseDate").value = data.date; filledAny = true; }
        if (data.vendor && !$("expenseVendor").value) { $("expenseVendor").value = data.vendor; filledAny = true; }
        if (filledAny) {
          $("expenseOcrStatus").classList.add("hidden");
        } else {
          $("expenseOcrStatus").textContent = "Couldn't read this receipt clearly — enter the details manually.";
        }
      } catch (err) {
        $("expenseOcrStatus").textContent = "Couldn't reach the scanner. Check your connection and try again, or enter the details manually.";
      } finally {
        $("expenseAutoFillBtn").disabled = false;
      }
    };
    reader.readAsDataURL(file);
  }

  async function onFormSubmit(evt) {
    evt.preventDefault();
    var amount = parseFloat($("expenseAmount").value);
    if (!amount || amount <= 0) {
      showFormError("Enter a valid amount.");
      return;
    }
    var saveBtn = $("expenseFormSave");
    saveBtn.disabled = true;
    try {
      var expenseId = state.editingExpenseId || generateId();
      var isNew = !state.editingExpenseId;

      var receiptImageUrl = null;
      var receiptStoragePath = null;
      if (state.pendingReceiptBlob) {
        var path = "tenantPrivate/" + state.tenantId + "/expenseReceipts/" + expenseId + ".jpg";
        var ref = state.storage.ref(path);
        await ref.put(state.pendingReceiptBlob, { contentType: "image/jpeg" });
        receiptImageUrl = await ref.getDownloadURL();
        receiptStoragePath = path;
      }

      var data = {
        amountCents: Math.round(amount * 100),
        currency: "usd",
        category: $("expenseCategory").value,
        vendor: $("expenseVendor").value.trim(),
        date: firebase.firestore.Timestamp.fromDate(new Date($("expenseDate").value + "T00:00:00")),
        note: $("expenseNote").value.trim() || firebase.firestore.FieldValue.delete(),
        source: state.pendingReceiptBlob ? "ocr" : "manual",
        updatedAt: firebase.firestore.Timestamp.now(),
      };
      if (receiptImageUrl) data.receiptImageUrl = receiptImageUrl;
      if (receiptStoragePath) data.receiptStoragePath = receiptStoragePath;
      if (isNew) data.createdAt = firebase.firestore.Timestamp.now();

      await state.firestore.collection("tenants").doc(state.tenantId).collection("expenses").doc(expenseId).set(data, { merge: true });

      $("expenseFormDialog").close();
      widenRangeIfNeeded(new Date($("expenseDate").value + "T00:00:00"));
      await loadAndRender();
    } catch (err) {
      showFormError("Couldn't save expense. Please try again.");
    } finally {
      saveBtn.disabled = false;
    }
  }

  /// A saved expense's date can predate the visible range (e.g. an old receipt scanned
  /// today) — without this it would save successfully but silently vanish from the list.
  function widenRangeIfNeeded(date) {
    if (dateInputValue(date) < $("expensesRangeStart").value) $("expensesRangeStart").value = dateInputValue(date);
    if (dateInputValue(date) > $("expensesRangeEnd").value) $("expensesRangeEnd").value = dateInputValue(date);
  }

  function showFormError(msg) {
    var el = $("expenseFormError");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function csvEscape(field) {
    field = String(field == null ? "" : field);
    if (/[",\n]/.test(field)) {
      return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
  }

  function exportCsv() {
    var lines = ["Date,Category,Vendor,Amount,Note,Source,Receipt URL"];
    state.rows.slice().sort(function (a, b) { return a.date - b.date; }).forEach(function (r) {
      lines.push([
        dateInputValue(r.date),
        r.categoryLabel,
        r.vendor,
        (r.amountCents / 100).toFixed(2),
        r.note,
        r.sourceLabel,
        r.receiptImageUrl || "",
      ].map(csvEscape).join(","));
    });
    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "expenses.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.Expenses = { init: init };
})();
