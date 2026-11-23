/**
 * Shop portal Ads: connect a Meta ad account, read campaign results, and publish
 * a campaign, ad set, and ad. Owner only. Insights is unchanged.
 */
(function (global) {
  "use strict";

  var REGION = "us-central1";
  var RANGES = [
    { id: "30", label: "30 days", days: 30 },
    { id: "90", label: "90 days", days: 90 },
    { id: "365", label: "12 months", days: 365 },
  ];
  var OBJECTIVES = [
    { id: "awareness", label: "Awareness" },
    { id: "traffic", label: "Traffic" },
    { id: "engagement", label: "Engagement" },
    { id: "leads", label: "Leads" },
    { id: "app", label: "App" },
    { id: "sales", label: "Sales" },
  ];
  var CTAS = [
    { id: "book_now", label: "Book now" },
    { id: "learn_more", label: "Learn more" },
    { id: "sign_up", label: "Sign up" },
    { id: "shop_now", label: "Shop now" },
    { id: "send_message", label: "Send message" },
  ];

  var state = {
    session: null,
    connection: null,
    insights: null,
    campaigns: [],
    range: "30",
    tab: "campaigns",
    selectedId: "",
    mode: "list",
    step: 0,
    draft: freshDraft(),
    error: "",
    busy: false,
    waiting: false,
    loaded: false,
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function freshDraft() {
    return {
      name: "",
      objective: "sales",
      specialAdCategory: "none",
      advantageBudget: true,
      budgetType: "daily",
      budget: "20",
      bidStrategy: "highest_volume",
      bidAmount: "",
      adSetName: "People near the shop",
      conversionLocation: "website",
      performanceGoal: "link_clicks",
      customEventType: "SCHEDULE",
      pixelId: "",
      pageId: "",
      applicationId: "",
      storeUrl: "",
      country: "US",
      latitude: "",
      longitude: "",
      radiusMiles: "15",
      ageMin: "18",
      endDate: "",
      advantageAudience: true,
      advantagePlacements: true,
      adName: "",
      setup: "create",
      format: "image",
      postId: "",
      imageUrl: "",
      message: "",
      headline: "",
      description: "",
      callToAction: "book_now",
      link: "",
      instagramUserId: "",
      advantageCreative: true,
      preview: "instagram",
    };
  }

  function tenant() { return (state.session && state.session.tenant) || {}; }

  function isDemo() { return tenant().isDemoAccount === true; }

  function isPaid() {
    var t = tenant();
    if (t.complimentaryPaidAccess === true) return true;
    var billing = String(t.stripeCustomerId || "").trim() || String(t.billingSource || "") === "apple";
    if (!billing) return false;
    return String(t.subscriptionStatus || "").trim().toLowerCase() === "active";
  }

  function currency() {
    return (state.connection && state.connection.currency) || "USD";
  }

  function money(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency(),
        maximumFractionDigits: n >= 100 ? 0 : 2,
      }).format(n);
    } catch (e) {
      return "$" + n.toFixed(2);
    }
  }

  function compact(value) {
    var n = Number(value) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function labelize(value) {
    var raw = String(value || "").replace(/_/g, " ").toLowerCase();
    return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "—";
  }

  function callableMessage(e, fallback) {
    var msg = String((e && e.message) || "").trim();
    var prev = "";
    while (msg && msg !== prev) {
      prev = msg;
      msg = msg.replace(/^(FirebaseError|[a-z0-9-]+):\s*/i, "").trim();
    }
    return msg || fallback;
  }

  function call(name, data) {
    return firebase.app().functions(REGION).httpsCallable(name)(data || {}).then(function (res) {
      return res.data || {};
    });
  }

  function bounds() {
    var spec = RANGES.filter(function (r) { return r.id === state.range; })[0] || RANGES[0];
    var end = new Date();
    var start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (spec.days - 1));
    function iso(d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    return { since: iso(start), until: iso(end) };
  }

  function needsPixel(draft) {
    if (draft.objective === "sales" || draft.objective === "leads") return true;
    return draft.objective === "traffic" && draft.performanceGoal === "landing_page_views";
  }

  function publishError(draft) {
    if (!String(draft.name || "").trim()) return "Name the campaign.";
    if (!(Number(draft.budget) > 0)) return "Enter a budget greater than zero.";
    if (draft.budgetType === "lifetime" && !/^\d{4}-\d{2}-\d{2}$/.test(draft.endDate || "")) {
      return "A lifetime budget needs an end date.";
    }
    if (draft.bidStrategy !== "highest_volume" && !(Number(draft.bidAmount) > 0)) return "Enter a bid amount.";
    if (!draft.pageId) return "Choose a Facebook Page.";
    if (needsPixel(draft) && !draft.pixelId) return "Choose a dataset before publishing this campaign.";
    if (draft.objective === "app") {
      if (!String(draft.applicationId || "").trim()) return "App promotion needs an app id and a store link.";
      if (String(draft.storeUrl || "").indexOf("https://") !== 0) return "The store link must be a full https link.";
    }
    if (!/^[A-Za-z]{2}$/.test(String(draft.country || "").trim()) && !(draft.latitude && draft.longitude)) {
      return "Add a location for this ad set.";
    }
    if (draft.format !== "image" && draft.setup !== "post") {
      return "This version publishes a single image or an existing post.";
    }
    if (draft.setup === "post") {
      if (!String(draft.postId || "").trim()) return "Paste the post id.";
      return "";
    }
    if (String(draft.imageUrl || "").indexOf("https://") !== 0) return "The photo must be a full https link.";
    if (!String(draft.message || "").trim()) return "Write the primary text.";
    if (!String(draft.headline || "").trim()) return "Write a headline.";
    if (String(draft.link || "").indexOf("https://") !== 0) return "The website URL must be a full https link.";
    return "";
  }

  function payload(active) {
    var draft = state.draft;
    var adSet = {
      name: draft.adSetName,
      conversionLocation: draft.conversionLocation,
      pageId: draft.pageId,
      countries: [String(draft.country || "").trim().toUpperCase()],
      ageMin: Number(draft.ageMin) || 18,
      advantageAudience: !!draft.advantageAudience,
      advantagePlacements: !!draft.advantagePlacements,
    };
    if (needsPixel(draft)) {
      adSet.pixelId = draft.pixelId;
      if (draft.objective === "sales") adSet.customEventType = draft.customEventType;
    }
    if (draft.objective === "traffic") adSet.performanceGoal = draft.performanceGoal;
    if (draft.objective === "app") {
      adSet.applicationId = String(draft.applicationId || "").trim();
      adSet.storeUrl = String(draft.storeUrl || "").trim();
    }
    if (draft.latitude && draft.longitude) {
      adSet.latitude = Number(draft.latitude);
      adSet.longitude = Number(draft.longitude);
      adSet.radiusMiles = Number(draft.radiusMiles) || 15;
    }
    if (draft.endDate) adSet.endTime = draft.endDate + "T23:59:59Z";
    var ad = {
      name: draft.adName || draft.name,
      pageId: draft.pageId,
      callToAction: draft.callToAction,
      advantageCreative: !!draft.advantageCreative,
    };
    if (draft.instagramUserId) ad.instagramUserId = draft.instagramUserId;
    if (draft.setup === "post") {
      ad.postId = String(draft.postId || "").trim();
    } else {
      ad.message = draft.message;
      ad.headline = draft.headline;
      ad.description = draft.description;
      ad.link = String(draft.link || "").trim();
      ad.imageUrl = String(draft.imageUrl || "").trim();
    }
    var body = {
      name: draft.name,
      objective: draft.objective,
      specialAdCategory: draft.specialAdCategory,
      advantageCampaignBudget: !!draft.advantageBudget,
      budgetType: draft.budgetType,
      budget: Number(draft.budget),
      bidStrategy: draft.bidStrategy,
      status: active ? "active" : "paused",
      adSet: adSet,
      ad: ad,
    };
    if (draft.endDate) body.endTime = draft.endDate + "T23:59:59Z";
    if (draft.bidStrategy !== "highest_volume") body.bidAmount = Number(draft.bidAmount);
    return body;
  }

  function load(session) {
    state.session = session;
    if (!state.wired) {
      state.wired = true;
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible" && state.waiting) {
          state.waiting = false;
          refresh();
        }
      });
    }
    if (state.session && state.session.isOwner && !isDemo() && isPaid()) refresh();
    else paint();
  }

  function refresh() {
    state.busy = true;
    state.error = "";
    paint();
    call("getMetaAdsConnection").then(function (data) {
      state.connection = data;
      state.loaded = true;
      seedDraft();
      if (data.status === "connected") return loadNumbers();
      state.busy = false;
      paint();
    }).catch(function (e) {
      state.busy = false;
      state.loaded = true;
      state.error = callableMessage(e, "Couldn’t load Meta ads.");
      paint();
    });
  }

  function seedDraft() {
    var conn = state.connection || {};
    var pages = conn.pages || [];
    var pixels = conn.pixels || [];
    if (!state.draft.pageId && pages[0]) {
      state.draft.pageId = pages[0].id;
      state.draft.instagramUserId = pages[0].instagramUserId || "";
    }
    if (!state.draft.pixelId && pixels[0]) state.draft.pixelId = pixels[0].id;
  }

  function loadNumbers() {
    var dates = bounds();
    return Promise.all([
      call("getMetaAdsInsights", dates),
      call("listMetaCampaigns", dates),
    ]).then(function (pair) {
      state.insights = pair[0];
      state.campaigns = (pair[1] && pair[1].campaigns) || [];
      if (pair[1] && pair[1].account && pair[1].account.currency && state.connection) {
        state.connection.currency = pair[1].account.currency;
      }
      state.busy = false;
      paint();
    }).catch(function (e) {
      state.busy = false;
      state.error = callableMessage(e, "Couldn’t load campaign results.");
      paint();
    });
  }

  function connect() {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    paint();
    var popup = window.open("about:blank", "_blank");
    call("startMetaAdsConnect").then(function (data) {
      var url = data.authorizeUrl;
      if (!url) throw new Error("Meta did not return a connect link.");
      state.waiting = true;
      if (popup) popup.location.href = url;
      else window.location.href = url;
      state.busy = false;
      paint();
    }).catch(function (e) {
      if (popup) popup.close();
      state.busy = false;
      state.error = callableMessage(e, "Couldn’t open Meta.");
      paint();
    });
  }

  function disconnect() {
    if (state.busy || !window.confirm("Disconnect Meta ads?")) return;
    state.busy = true;
    call("disconnectMetaAds").then(function () {
      state.connection = { status: "off" };
      state.campaigns = [];
      state.insights = null;
      state.busy = false;
      paint();
    }).catch(function (e) {
      state.busy = false;
      state.error = callableMessage(e, "Couldn’t disconnect Meta ads.");
      paint();
    });
  }

  function selectAccount(id) {
    state.busy = true;
    state.error = "";
    paint();
    call("selectMetaAdAccount", { accountId: id }).then(function () {
      return refresh();
    }).catch(function (e) {
      state.busy = false;
      state.error = callableMessage(e, "Couldn’t choose that ad account.");
      paint();
    });
  }

  function openEditor() {
    state.mode = "editor";
    state.step = 0;
    state.error = "";
    state.draft = freshDraft();
    seedDraft();
    paint();
  }

  function closeEditor() {
    state.mode = "list";
    state.error = "";
    paint();
  }

  function setStep(n) {
    state.step = n;
    state.error = "";
    paint();
  }

  function set(key, value) {
    state.draft[key] = value;
    var node = $("adsError");
    if (node) node.textContent = "";
    var card = document.querySelector(".app-ads-preview-card");
    if (!card || state.step !== 2) return;
    var cta = CTAS.filter(function (item) { return item.id === state.draft.callToAction; })[0];
    card.innerHTML = "<strong>" + esc(state.draft.headline || "Headline") + "</strong><p>" +
      esc(state.draft.message || "Primary text") + '</p><span class="app-btn app-btn--primary">' +
      esc((cta && cta.label) || "Book now") + "</span>";
  }

  function setPaint(key, value) {
    state.draft[key] = value;
    if (key === "pageId") {
      var page = ((state.connection && state.connection.pages) || []).filter(function (p) { return p.id === value; })[0];
      state.draft.instagramUserId = page && page.instagramUserId ? page.instagramUserId : "";
    }
    state.error = "";
    paint();
  }

  function setRange(id) {
    state.range = id;
    if (state.connection && state.connection.status === "connected") {
      state.busy = true;
      paint();
      loadNumbers();
    } else paint();
  }

  function setTab(id) {
    state.tab = id;
    paint();
  }

  function selectCampaign(id) {
    state.selectedId = state.selectedId === id ? "" : id;
    paint();
  }

  function publish(active) {
    var problem = publishError(state.draft);
    if (problem) {
      state.error = problem;
      paint();
      return;
    }
    state.busy = true;
    state.error = "";
    paint();
    call("publishMetaCampaign", payload(active)).then(function () {
      state.busy = false;
      state.mode = "list";
      refresh();
    }).catch(function (e) {
      state.busy = false;
      state.error = callableMessage(e, "Couldn’t publish that campaign.");
      paint();
    });
  }

  function paint() {
    var root = $("adsRoot");
    if (!root) return;
    root.innerHTML = bodyHtml();
  }

  function bodyHtml() {
    if (!state.session || !state.session.isOwner) {
      return note("Only the business owner can connect Meta ads.");
    }
    if (isDemo()) return page("Ads", note("Meta ads are unavailable on the demo account."));
    if (!isPaid()) {
      return page("Ads", note("Your free trial includes the website builder. Start your paid Get Bookking plan to connect Meta ads."));
    }
    if (state.mode === "editor") return editorHtml();
    return listHtml();
  }

  function page(title, inner) {
    return '<div class="app-greeting app-pay-head"><div><h1>' + esc(title) + '</h1>' +
      '<p>Campaigns for the Meta ad account you already run.</p></div></div>' + inner + errorHtml();
  }

  function note(text) {
    return '<p class="app-hint">' + esc(text) + "</p>";
  }

  function errorHtml() {
    return state.error ? '<p class="app-sheet-error" id="adsError">' + esc(state.error) + "</p>" : '<p class="app-sheet-error" id="adsError"></p>';
  }

  function listHtml() {
    var conn = state.connection || {};
    var status = conn.status || "off";
    var head = '<div class="app-greeting app-pay-head"><div><h1>Ads</h1>' +
      '<p>' + esc(conn.accountName || "Connect the Meta ad account you already run.") + "</p></div>" +
      '<div class="app-pay-head-actions">';
    if (status === "connected") {
      head += '<button type="button" class="app-btn app-btn--primary" onclick="ShopAppAds.openEditor()">New campaign</button>';
    }
    head += "</div></div>";
    var inner = "";
    if (!state.loaded && state.busy) inner = note("Loading ads…");
    else if (status === "connected") inner = connectedHtml();
    else if (status === "choose_account") inner = accountPicker("Choose the ad account for this business.");
    else inner = connectHtml(status);
    return head + inner + errorHtml();
  }

  function connectHtml(status) {
    var extra = "";
    if (status === "failed" || status === "expired") {
      extra = note((state.connection && state.connection.error) || "Meta ads could not be connected.");
    } else if (status === "connecting" || state.waiting) {
      extra = note("Connecting Meta ads… Finish in the Meta window, then come back here.");
    }
    return '<div class="app-card app-ads-card">' + extra +
      '<p class="app-hint">New campaign, then Campaign, Ad set, and Ad.</p>' +
      '<button type="button" class="app-btn app-btn--primary" onclick="ShopAppAds.connect()" ' +
      (state.busy ? "disabled" : "") + ">" + (status === "off" ? "Connect Meta ads" : "Connect again") + "</button></div>";
  }

  function accountPicker(lead) {
    var accounts = (state.connection && state.connection.adAccounts) || [];
    var rows = accounts.map(function (account) {
      return '<button type="button" class="app-btn app-btn--ghost" onclick="ShopAppAds.selectAccount(\'' + esc(account.id) + '\')">' +
        esc(account.name || account.id) + (account.currency ? " · " + esc(account.currency) : "") + "</button>";
    }).join("");
    return '<div class="app-card app-ads-card"><p class="app-hint">' + esc(lead) + "</p>" +
      '<div class="app-ads-accounts">' + (rows || note("No ad accounts on this Meta login.")) + "</div>" +
      '<button type="button" class="app-btn app-btn--warm" onclick="ShopAppAds.disconnect()">Disconnect</button></div>';
  }

  function connectedHtml() {
    var insights = state.insights || {};
    var ranges = '<div class="app-seg" role="tablist">' + RANGES.map(function (r) {
      return '<button type="button" class="' + (state.range === r.id ? "is-on" : "") + '" onclick="ShopAppAds.setRange(\'' + r.id + '\')">' + esc(r.label) + "</button>";
    }).join("") + "</div>";
    var tiles = '<div class="app-ins-tiles app-ads-tiles">' +
      tile("Spend", money(insights.spend || 0)) +
      tile("Impressions", compact(insights.impressions)) +
      tile("Clicks", compact(insights.clicks)) +
      tile("Results", String(insights.results || 0)) +
      "</div>";
    var tabs = '<div class="app-seg" role="tablist">' +
      tabBtn("campaigns", "Campaigns") + tabBtn("adsets", "Ad sets") + tabBtn("ads", "Ads") + "</div>";
    return '<div class="app-ads-tools">' + ranges +
      '<button type="button" class="app-btn app-btn--warm" onclick="ShopAppAds.disconnect()">Disconnect</button></div>' +
      tiles + tabs + tableHtml() +
      ((state.connection.adAccounts || []).length > 1 ? accountPicker("Switch ad account") : "");
  }

  function tile(label, value) {
    return '<article class="app-card"><p class="app-hint">' + esc(label) + '</p><strong class="app-ads-metric">' + esc(value) + "</strong></article>";
  }

  function tabBtn(id, label) {
    return '<button type="button" class="' + (state.tab === id ? "is-on" : "") + '" onclick="ShopAppAds.setTab(\'' + id + '\')">' + label + "</button>";
  }

  function tableHtml() {
    if (state.tab !== "campaigns") {
      return '<p class="app-hint">Each campaign is published with one ad set and one ad. Results are counted on the campaign.</p>' + campaignTable();
    }
    return campaignTable();
  }

  function campaignTable() {
    if (!state.campaigns.length) return '<p class="app-hint">No campaigns yet.</p>';
    var rows = state.campaigns.map(function (row) {
      var budget = row.dailyBudget != null ? money(row.dailyBudget) + "/day" : (row.lifetimeBudget != null ? money(row.lifetimeBudget) + " lifetime" : "Ad set budget");
      var selected = state.selectedId === row.id ? " is-selected" : "";
      return '<tr class="' + selected + '" onclick="ShopAppAds.selectCampaign(\'' + esc(row.id) + '\')">' +
        "<td>" + esc(row.name) + "</td><td>" + esc(labelize(row.delivery)) + "</td><td>" + esc(budget) +
        "</td><td>" + esc(String(row.results || 0)) + "</td><td>" + esc(row.costPerResult != null ? money(row.costPerResult) : "—") + "</td></tr>";
    }).join("");
    var detail = "";
    var picked = state.campaigns.filter(function (row) { return row.id === state.selectedId; })[0];
    if (picked) {
      detail = '<div class="app-ads-tiles">' +
        tile("Spend", money(picked.spend || 0)) +
        tile("Impressions", compact(picked.impressions)) +
        tile("Clicks", compact(picked.clicks)) +
        tile("Results", String(picked.results || 0)) +
        "</div>";
    }
    return '<div class="app-ads-table-wrap"><table class="app-table"><thead><tr>' +
      "<th>Name</th><th>Delivery</th><th>Budget</th><th>Results</th><th>Cost per result</th></tr></thead><tbody>" +
      rows + "</tbody></table></div>" + detail;
  }

  function editorHtml() {
    var steps = ["Campaign", "Ad set", "Ad"];
    var rail = steps.map(function (label, i) {
      return '<button type="button" class="' + (state.step === i ? "is-on" : "") + '" onclick="ShopAppAds.setStep(' + i + ')">' + label + "</button>";
    }).join("");
    var form = state.step === 0 ? campaignFields() : (state.step === 1 ? adSetFields() : adFields());
    var preview = state.step === 2 ? '<aside class="app-ads-preview">' + previewHtml() + "</aside>" : "";
    return '<div class="app-greeting app-pay-head"><div><h1>Create campaign</h1><p>Campaign, ad set, and ad.</p></div>' +
      '<div class="app-pay-head-actions">' +
      '<button type="button" class="app-btn app-btn--ghost" onclick="ShopAppAds.closeEditor()">Close</button>' +
      '<button type="button" class="app-btn app-btn--ghost" onclick="ShopAppAds.publish(false)" ' + (state.busy ? "disabled" : "") + '>Save paused</button>' +
      '<button type="button" class="app-btn app-btn--primary" onclick="ShopAppAds.publish(true)" ' + (state.busy ? "disabled" : "") + '>' +
      (state.busy ? "Publishing…" : "Publish") + "</button></div></div>" +
      '<div class="app-ads-editor' + (state.step === 2 ? " is-preview" : "") + '">' +
      '<nav class="app-ads-steps">' + rail + "</nav><div>" + form + "</div>" + preview + "</div>" + errorHtml();
  }

  function field(label, key, extra) {
    extra = extra || "";
    return '<div class="app-field"><label>' + esc(label) + '</label><input ' + extra + ' value="' + esc(state.draft[key] || "") +
      '" oninput="ShopAppAds.set(\'' + key + '\', this.value)" /></div>';
  }

  function select(label, key, options, paint) {
    var setter = paint ? "setPaint" : "set";
    var opts = options.map(function (opt) {
      var selected = String(state.draft[key] || "") === String(opt.id) ? " selected" : "";
      return '<option value="' + esc(opt.id) + '"' + selected + ">" + esc(opt.label) + "</option>";
    }).join("");
    return '<div class="app-field"><label>' + esc(label) + '</label><select onchange="ShopAppAds.' + setter + '(\'' + key + '\', this.value)">' +
      opts + "</select></div>";
  }

  function check(label, key) {
    return '<label class="app-ads-check"><input type="checkbox" ' + (state.draft[key] ? "checked" : "") +
      ' onchange="ShopAppAds.setPaint(\'' + key + '\', this.checked)" /> ' + esc(label) + "</label>";
  }

  function campaignFields() {
    var tiles = OBJECTIVES.map(function (obj) {
      return '<button type="button" class="' + (state.draft.objective === obj.id ? "is-on" : "") +
        '" onclick="ShopAppAds.setPaint(\'objective\', \'' + obj.id + '\')">' + esc(obj.label) + "</button>";
    }).join("");
    return field("Campaign name", "name") +
      select("Special ad category", "specialAdCategory", [
        { id: "none", label: "None" },
        { id: "housing", label: "Housing" },
        { id: "employment", label: "Employment" },
        { id: "credit", label: "Credit" },
        { id: "financial", label: "Financial products" },
      ], true) +
      '<p class="app-hint">Campaign objective</p><div class="app-ads-objectives">' + tiles + "</div>" +
      check("Advantage+ campaign budget", "advantageBudget") +
      '<div class="app-seg">' +
      seg("budgetType", "daily", "Daily") + seg("budgetType", "lifetime", "Lifetime") + "</div>" +
      field(state.draft.budgetType === "lifetime" ? "Lifetime budget" : "Daily budget", "budget", 'inputmode="decimal"') +
      (state.draft.budgetType === "lifetime" ? field("End date", "endDate", 'type="date"') : "") +
      select("Bid strategy", "bidStrategy", [
        { id: "highest_volume", label: "Highest volume" },
        { id: "cost_per_result", label: "Cost per result goal" },
        { id: "bid_cap", label: "Bid cap" },
      ], true) +
      (state.draft.bidStrategy === "highest_volume" ? "" : field("Bid amount", "bidAmount", 'inputmode="decimal"'));
  }

  function seg(key, id, label) {
    return '<button type="button" class="' + (state.draft[key] === id ? "is-on" : "") +
      '" onclick="ShopAppAds.setPaint(\'' + key + '\', \'' + id + '\')">' + label + "</button>";
  }

  function adSetFields() {
    var draft = state.draft;
    var pages = ((state.connection && state.connection.pages) || []).map(function (p) {
      return { id: p.id, label: p.name || p.id };
    });
    var pixels = ((state.connection && state.connection.pixels) || []).map(function (p) {
      return { id: p.id, label: p.name || p.id };
    });
    var goal = "";
    if (draft.objective === "traffic") {
      goal = select("Performance goal", "performanceGoal", [
        { id: "link_clicks", label: "Maximize link clicks" },
        { id: "landing_page_views", label: "Maximize landing page views" },
      ], true);
    } else if (draft.objective === "sales" || draft.objective === "leads") {
      goal = '<p class="app-hint">Performance goal: Maximize number of conversions</p>';
    }
    var dataset = needsPixel(draft)
      ? select("Dataset", "pixelId", [{ id: "", label: "Choose a dataset" }].concat(pixels), true) +
        (draft.objective === "sales" ? select("Conversion event", "customEventType", [
          { id: "SCHEDULE", label: "Schedule" },
          { id: "PURCHASE", label: "Purchase" },
          { id: "LEAD", label: "Lead" },
        ], false) : "")
      : "";
    var app = draft.objective === "app" ? field("App id", "applicationId") + field("Store link", "storeUrl") : "";
    var budgetNote = draft.advantageBudget
      ? '<p class="app-hint">Budget is set on the campaign.</p>'
      : field("Ad set budget", "budget", 'inputmode="decimal"');
    return field("Ad set name", "adSetName") +
      select("Conversion location", "conversionLocation", [
        { id: "website", label: "Website" },
        { id: "messenger", label: "Messenger" },
        { id: "instagram", label: "Instagram" },
      ], true) +
      goal + dataset + app +
      select("Facebook Page", "pageId", [{ id: "", label: "Choose a Page" }].concat(pages), true) +
      budgetNote +
      '<p class="app-hint">Starts today. Add an end date only if the campaign should stop.</p>' +
      (draft.budgetType === "lifetime" ? "" : field("End date (optional)", "endDate", 'type="date"')) +
      check("Advantage+ audience", "advantageAudience") +
      '<p class="app-hint">Location uses the country unless you add a point. A radius needs latitude and longitude.</p>' +
      field("Country", "country") +
      field("Latitude (optional)", "latitude", 'inputmode="decimal"') +
      field("Longitude (optional)", "longitude", 'inputmode="decimal"') +
      field("Radius in miles", "radiusMiles", 'inputmode="decimal"') +
      field("Minimum age", "ageMin", 'inputmode="numeric"') +
      check("Advantage+ placements", "advantagePlacements");
  }

  function adFields() {
    var draft = state.draft;
    var page = ((state.connection && state.connection.pages) || []).filter(function (p) { return p.id === draft.pageId; })[0];
    var ig = page && page.instagramUsername ? "Shown with @" + page.instagramUsername : (draft.instagramUserId ? "Shown on the Instagram account linked to this Page." : "This Page has no Instagram account on the connection.");
    var formats = [
      { id: "image", label: "Single image or video" },
      { id: "carousel", label: "Carousel" },
      { id: "collection", label: "Collection" },
    ].map(function (fmt) {
      return '<button type="button" class="' + (draft.format === fmt.id ? "is-on" : "") +
        '" onclick="ShopAppAds.setPaint(\'format\', \'' + fmt.id + '\')">' + esc(fmt.label) + "</button>";
    }).join("");
    var body = draft.setup === "post"
      ? field("Post id", "postId")
      : field("Photo URL", "imageUrl") +
        '<div class="app-field"><label>Primary text</label><textarea oninput="ShopAppAds.set(\'message\', this.value)">' + esc(draft.message) + "</textarea></div>" +
        field("Headline", "headline") +
        field("Description", "description") +
        select("Call to action", "callToAction", CTAS, false) +
        field("Website URL", "link");
    return field("Ad name", "adName") +
      '<p class="app-hint">' + esc(ig) + "</p>" +
      '<div class="app-seg">' + seg("setup", "create", "Create ad") + seg("setup", "post", "Use existing post") + "</div>" +
      '<div class="app-ads-objectives">' + formats + "</div>" +
      (draft.format !== "image" && draft.setup !== "post" ? '<p class="app-hint">This version publishes a single image or an existing post.</p>' : "") +
      body +
      check("Advantage+ creative", "advantageCreative") +
      '<p class="app-hint">Tracking uses the dataset and Schedule event from the ad set.</p>';
  }

  function previewHtml() {
    var draft = state.draft;
    var places = [
      { id: "instagram", label: "Instagram Feed" },
      { id: "facebook", label: "Facebook Feed" },
      { id: "stories", label: "Stories" },
      { id: "reels", label: "Reels" },
    ].map(function (place) {
      return '<button type="button" class="' + (draft.preview === place.id ? "is-on" : "") +
        '" onclick="ShopAppAds.setPaint(\'preview\', \'' + place.id + '\')">' + place.label + "</button>";
    }).join("");
    var cta = CTAS.filter(function (c) { return c.id === draft.callToAction; })[0];
    return '<p class="app-hint">Preview</p><div class="app-seg app-ads-preview-tabs">' + places + "</div>" +
      '<article class="app-card app-ads-preview-card"><strong>' + esc(draft.headline || "Headline") + "</strong>" +
      "<p>" + esc(draft.message || "Primary text") + "</p>" +
      '<span class="app-btn app-btn--primary">' + esc((cta && cta.label) || "Book now") + "</span></article>";
  }

  global.ShopAppAds = {
    load: load,
    connect: connect,
    disconnect: disconnect,
    selectAccount: selectAccount,
    openEditor: openEditor,
    closeEditor: closeEditor,
    setStep: setStep,
    set: set,
    setPaint: setPaint,
    setRange: setRange,
    setTab: setTab,
    selectCampaign: selectCampaign,
    publish: publish,
  };
})(window);
