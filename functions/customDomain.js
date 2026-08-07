/**
 * Custom domains via Namecheap (buy / transfer) → Cloudflare nameservers → live site.
 *
 * Product rule: Connect only when Bookking manages the domain (Namecheap API).
 * No DIY DNS instructions in the app — transfer or buy, otherwise not available.
 *
 * Secrets:
 *   firebase functions:secrets:set NAMECHEAP_API_KEY
 * Params / env:
 *   NAMECHEAP_API_USER          (ApiUser)
 *   NAMECHEAP_USERNAME          (UserName; defaults to ApiUser)
 *   NAMECHEAP_CLIENT_IP         (must be whitelisted in Namecheap API access)
 *   NAMECHEAP_API_HOST          (sandbox default: https://api.sandbox.namecheap.com/xml.response)
 *   NAMECHEAP_NAMESERVER_1 / NAMECHEAP_NAMESERVER_2  (Cloudflare NS after zone setup)
 *
 * Enable API: 20 domains, $50 balance, or $50 spent in last 2 years.
 * Sandbox: free test account at Namecheap sandbox.
 */

const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { defineSecret, defineString } = require("firebase-functions/params");
const Stripe = require("stripe");
const { resolveWebThemeId } = require("./signupPayloads");

const namecheapApiKey = defineSecret("NAMECHEAP_API_KEY");
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripePublishableKeyParam = defineString("STRIPE_PUBLISHABLE_KEY", {
  default: "",
  description: "pk_test_… / pk_live_… returned to iOS for domain PaymentSheet",
});
const namecheapApiUser = defineString("NAMECHEAP_API_USER", {
  default: "",
  description: "Namecheap ApiUser",
});
const namecheapUsername = defineString("NAMECHEAP_USERNAME", {
  default: "",
  description: "Namecheap UserName (defaults to ApiUser if empty)",
});
const namecheapClientIp = defineString("NAMECHEAP_CLIENT_IP", {
  default: "",
  description: "Public IP whitelisted for Namecheap API (e.g. Cloud Functions egress)",
});
const namecheapApiHost = defineString("NAMECHEAP_API_HOST", {
  default: "https://api.sandbox.namecheap.com/xml.response",
  description: "Sandbox or https://api.namecheap.com/xml.response for live",
});
const namecheapNameserver1 = defineString("NAMECHEAP_NAMESERVER_1", {
  default: "",
  description: "Cloudflare nameserver 1 for Bookking-managed domains",
});
const namecheapNameserver2 = defineString("NAMECHEAP_NAMESERVER_2", {
  default: "",
  description: "Cloudflare nameserver 2 for Bookking-managed domains",
});
/** Flat USD added on top of Namecheap cost (customer-facing price). */
const domainMarkupUsd = defineString("DOMAIN_MARKUP_USD", {
  default: "0",
  description: "USD markup added to Namecheap register/transfer cost",
});
/** Percent markup on Namecheap cost (applied before flat USD). */
const domainMarkupPercent = defineString("DOMAIN_MARKUP_PERCENT", {
  default: "50",
  description: "Percent markup on Namecheap cost (Get Bookking absorbs Stripe fees)",
});

const DEFAULT_SEARCH_TLDS = ["com", "net", "org", "co"];

/** Optional static-IP proxy so Namecheap always sees NAMECHEAP_CLIENT_IP. */
const namecheapProxyUrl = defineString("NAMECHEAP_PROXY_URL", {
  default: "",
  description: "http://STATIC_IP:8080 — egress proxy with whitelisted IP",
});
const namecheapProxyToken = defineString("NAMECHEAP_PROXY_TOKEN", {
  default: "",
  description: "Shared secret for Namecheap proxy (x-proxy-token)",
});

/** Fallback 1-year USD if Namecheap getPricing is unavailable (e.g. some sandbox accounts). */
const FALLBACK_REGISTER_USD = { com: 13.98, net: 14.98, org: 13.98, co: 11.98 };
const FALLBACK_TRANSFER_USD = { com: 13.98, net: 14.98, org: 13.98, co: 11.98 };

function getDb() {
  return admin.firestore();
}

function normalizeDomain(raw) {
  let d = (raw || "").toString().trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/\/.*$/, "");
  d = d.replace(/\.$/, "");
  if (d.startsWith("www.")) d = d.slice(4);
  return d;
}

function isValidDomain(domain) {
  if (!domain || domain.length > 253) return false;
  if (domain.includes("..") || domain.startsWith("-") || domain.endsWith("-")) return false;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) return false;
  if (domain.endsWith(".getbookking.com") || domain.endsWith(".getbooking.com")) return false;
  return true;
}

function wwwOf(domain) {
  return "www." + domain;
}

function hostDocId(host) {
  return (host || "").toString().trim().toLowerCase();
}

function splitSldTld(domain) {
  const parts = domain.split(".");
  if (parts.length < 2) return { sld: domain, tld: "" };
  const tld = parts.pop();
  const sld = parts.join(".");
  return { sld, tld };
}

function namecheapConfigured() {
  const user = (namecheapApiUser.value() || "").trim();
  const ip = (namecheapClientIp.value() || "").trim();
  return !!(user && ip);
}

function encodeEppCode(raw) {
  const code = (raw || "").toString().trim();
  if (!code) return "";
  // Namecheap: special characters must be sent as base64:…
  if (/[^A-Za-z0-9]/.test(code)) {
    return "base64:" + Buffer.from(code, "utf8").toString("base64");
  }
  return code;
}

async function namecheapRequest(command, extraParams) {
  const apiKey = (namecheapApiKey.value() || "").trim();
  const apiUser = (namecheapApiUser.value() || "").trim();
  const userName = (namecheapUsername.value() || "").trim() || apiUser;
  const clientIp = (namecheapClientIp.value() || "").trim();
  const host =
    (namecheapApiHost.value() || "").trim() ||
    "https://api.sandbox.namecheap.com/xml.response";

  if (!apiKey || !apiUser || !clientIp) {
    const err = new Error(
      "Domain service is not connected yet. Add Namecheap API credentials to enable Buy and Transfer."
    );
    err.code = "namecheap-not-configured";
    throw err;
  }

  const params = new URLSearchParams();
  params.set("ApiUser", apiUser);
  params.set("ApiKey", apiKey);
  params.set("UserName", userName);
  params.set("ClientIp", clientIp);
  params.set("Command", command);
  Object.keys(extraParams || {}).forEach((k) => {
    const v = extraParams[k];
    if (v == null || v === "") return;
    params.set(k, String(v));
  });

  // Prefer static-IP proxy (Cloud Functions egress rotates; Namecheap requires a fixed whitelist IP).
  const proxyBase = (namecheapProxyUrl.value() || "").trim().replace(/\/$/, "");
  const proxyToken = (namecheapProxyToken.value() || "").trim();
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  let url = host;
  if (proxyBase) {
    url = `${proxyBase}/xml.response`;
    if (proxyToken) headers["x-proxy-token"] = proxyToken;
    try {
      const hostUrl = new URL(host);
      headers["x-namecheap-host"] = hostUrl.hostname;
    } catch (_) {
      /* keep default sandbox host on proxy */
    }
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Namecheap HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

function namecheapStatusOk(xmlText) {
  return /Status\s*=\s*"OK"/i.test(xmlText || "") || /<ApiResponse[^>]*Status="OK"/i.test(xmlText || "");
}

function namecheapErrorMessage(xmlText) {
  const m =
    /<Error[^>]*>([^<]+)<\/Error>/i.exec(xmlText || "") ||
    /Number="[^"]*"[^>]*>([^<]+)</i.exec(xmlText || "");
  let raw = "";
  if (m && m[1]) raw = m[1].trim();
  else {
    const desc = /<Errors>[\s\S]*?<Error[^>]*>([^<]+)/i.exec(xmlText || "");
    if (desc && desc[1]) raw = desc[1].trim();
  }
  if (!raw) return "Namecheap request failed";

  // Namecheap requires a fixed egress IP on the API whitelist.
  const ipMatch = /Invalid request IP:\s*([0-9.]+)/i.exec(raw);
  if (ipMatch) {
    const ip = ipMatch[1];
    return (
      `Namecheap blocked IP ${ip}. In Namecheap sandbox → Profile → Tools → API Access, ` +
      `whitelist ${ip}, then try again.`
    );
  }
  return raw;
}

function parseDomainCheckAvailable(xmlText, domain) {
  // <DomainCheckResult Domain="example.com" Available="true" ...
  const re = new RegExp(
    `DomainCheckResult[^>]*Domain="${domain.replace(/\./g, "\\.")}"[^>]*Available="(true|false)"`,
    "i"
  );
  let m = re.exec(xmlText || "");
  if (!m) {
    m = /Available="(true|false)"/i.exec(xmlText || "");
  }
  if (!m) return null;
  return m[1].toLowerCase() === "true";
}

/** Parse all DomainCheckResult rows from a multi-domain check response. */
function parseAllDomainChecks(xmlText) {
  const out = {};
  const re =
    /DomainCheckResult[^>]*Domain="([^"]+)"[^>]*Available="(true|false)"[^>]*(?:IsPremiumName="([^"]*)")?/gi;
  let m;
  while ((m = re.exec(xmlText || ""))) {
    out[m[1].toLowerCase()] = {
      available: m[2].toLowerCase() === "true",
      premium: (m[3] || "").toLowerCase() === "true",
    };
  }
  // Alternate attribute order: Available before Domain
  const re2 =
    /DomainCheckResult[^>]*Available="(true|false)"[^>]*Domain="([^"]+)"/gi;
  while ((m = re2.exec(xmlText || ""))) {
    const domain = m[2].toLowerCase();
    if (!out[domain]) {
      out[domain] = { available: m[1].toLowerCase() === "true", premium: false };
    }
  }
  return out;
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

function readMarkupConfig() {
  const usd = parseFloat((domainMarkupUsd.value() || "0").toString()) || 0;
  const percent = parseFloat((domainMarkupPercent.value() || "0").toString()) || 0;
  return { usd, percent };
}

function applyCustomerMarkup(wholesale) {
  const w = Number(wholesale);
  if (!Number.isFinite(w) || w < 0) return null;
  const { usd, percent } = readMarkupConfig();
  return roundMoney(w * (1 + percent / 100) + usd);
}

function usdToCents(amount) {
  return Math.round(Number(amount) * 100);
}

function getStripe() {
  const secretKey = (stripeSecretKey.value() || "").trim();
  if (!secretKey) {
    const err = new Error("Stripe is not configured.");
    err.code = "stripe-not-configured";
    throw err;
  }
  return new Stripe(secretKey, { apiVersion: "2024-11-20.acacia" });
}

async function resolveCustomerDomainPrice(domain, action) {
  const { tld } = splitSldTld(domain);
  const actionName = (action || "REGISTER").toUpperCase() === "TRANSFER" ? "TRANSFER" : "REGISTER";
  let wholesale = null;
  try {
    const raw = await namecheapRequest("namecheap.users.getPricing", {
      ProductType: "DOMAIN",
      ActionName: actionName,
    });
    if (namecheapStatusOk(raw)) {
      wholesale = parseTldPriceFromPricingXml(raw, tld, actionName);
    }
  } catch (e) {
    console.warn("getPricing failed", e.message || e);
  }
  if (wholesale == null) {
    wholesale =
      actionName === "TRANSFER"
        ? FALLBACK_TRANSFER_USD[tld] ?? 13.98
        : FALLBACK_REGISTER_USD[tld] ?? 13.98;
  }
  const markedUp = applyCustomerMarkup(wholesale);
  const customer = markedUp != null ? markedUp : roundMoney(wholesale);
  const totalCents = Math.max(50, usdToCents(customer));
  return {
    wholesale: roundMoney(wholesale),
    /** Marked-up price the customer pays (Get Bookking absorbs Stripe fees). */
    customer,
    totalCents,
    baseCents: totalCents,
    platformFeeCents: 0,
    tld,
    action: actionName,
    markup: readMarkupConfig(),
  };
}

function dollarsToCents(amount) {
  return Math.max(50, usdToCents(amount));
}

/**
 * Extract 1-year YourPrice/Price for a TLD from namecheap.users.getPricing XML.
 * action: REGISTER | TRANSFER
 */
function parseTldPriceFromPricingXml(xmlText, tld, action) {
  const tldKey = (tld || "").toLowerCase();
  const actionKey = (action || "REGISTER").toUpperCase();
  // Prefer ProductCategory Name="REGISTER" / "TRANSFER" blocks
  const catRe = new RegExp(
    `<ProductCategory[^>]*Name="${actionKey}"[^>]*>([\\s\\S]*?)</ProductCategory>`,
    "i"
  );
  let block = xmlText || "";
  const catMatch = catRe.exec(xmlText || "");
  if (catMatch) block = catMatch[1];

  const productRe = new RegExp(
    `<Product[^>]*Name="${tldKey}"[^>]*>([\\s\\S]*?)</Product>`,
    "i"
  );
  const productMatch = productRe.exec(block);
  if (!productMatch) return null;
  const productXml = productMatch[1];
  // Prefer Duration="1" YEAR
  const price1 =
    /<Price[^>]*Duration="1"[^>]*DurationType="YEAR"[^>]*YourPrice="([^"]+)"/i.exec(
      productXml
    ) ||
    /<Price[^>]*Duration="1"[^>]*DurationType="YEAR"[^>]*Price="([^"]+)"/i.exec(
      productXml
    ) ||
    /YourPrice="([^"]+)"/i.exec(productXml) ||
    /Price="([^"]+)"/i.exec(productXml);
  if (!price1) return null;
  const n = parseFloat(price1[1]);
  return Number.isFinite(n) ? n : null;
}

function normalizeSearchQuery(raw) {
  let q = (raw || "").toString().trim().toLowerCase();
  q = q.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (q.startsWith("www.")) q = q.slice(4);
  return q;
}

function buildSearchDomainList(query) {
  const q = normalizeSearchQuery(query);
  if (!q) return [];
  const domains = [];
  const seen = new Set();
  const push = (d) => {
    if (!d || seen.has(d) || !isValidDomain(d)) return;
    seen.add(d);
    domains.push(d);
  };

  if (q.includes(".")) {
    push(q);
    const { sld, tld } = splitSldTld(q);
    if (sld && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(sld)) {
      for (const t of DEFAULT_SEARCH_TLDS) {
        if (t !== tld) push(`${sld}.${t}`);
      }
    }
  } else {
    const sld = q.replace(/[^a-z0-9-]/g, "");
    if (!sld || sld.length < 1) return [];
    for (const t of DEFAULT_SEARCH_TLDS) {
      push(`${sld}.${t}`);
    }
  }
  return domains.slice(0, 8);
}

function formatMoneyLabel(amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return `$${Number(amount).toFixed(2)}/yr`;
}

function isSandboxHost() {
  const host = (namecheapApiHost.value() || "").toLowerCase();
  return host.includes("sandbox");
}

function toNamecheapPhone(raw) {
  const digits = (raw || "").toString().replace(/\D/g, "");
  if (digits.length === 10) return `+1.${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1.${digits.slice(1)}`;
  if (digits.length >= 8) return `+1.${digits.slice(-10)}`;
  return "+1.6155001337";
}

function splitPersonName(raw, fallbackFirst, fallbackLast) {
  const s = (raw || "").toString().trim();
  if (!s) return { first: fallbackFirst, last: fallbackLast };
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: fallbackLast };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function parseServiceArea(tenant) {
  const area = (tenant.serviceArea || "").toString().trim();
  let city = (tenant.serviceCity || "").toString().trim() || "Saint Petersburg";
  let state = (tenant.serviceStateAbbr || "").toString().trim() || "FL";
  let postal = "33710";
  if (area) {
    const parts = area.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts[0]) city = parts[0];
    if (parts[1]) {
      const tail = parts[1].split(/\s+/).filter(Boolean);
      if (tail[0] && tail[0].length <= 3) state = tail[0].toUpperCase();
      if (tail[1] && /^\d{5}/.test(tail[1])) postal = tail[1];
    }
  }
  return { city, state, postal };
}

/** Build Namecheap contact params (Registrant/Tech/Admin/AuxBilling) from tenant + owner. */
function buildDomainContactParams(tenant, ownerUser) {
  const org =
    (tenant.businessName || tenant.displayName || "Get Bookking Customer").toString().trim() ||
    "Get Bookking Customer";
  const email =
    (tenant.contactEmail || (ownerUser && ownerUser.email) || "support@getbookking.com")
      .toString()
      .trim() || "support@getbookking.com";
  const phone = toNamecheapPhone(tenant.contactPhone || (ownerUser && ownerUser.phoneNumber));
  const address1 =
    (tenant.contactAddress || tenant.address || "6825 Stonesthrow Cir N").toString().trim() ||
    "6825 Stonesthrow Cir N";
  const address2 = (tenant.contactAddressSuite || "").toString().trim();
  const { city, state, postal } = parseServiceArea(tenant);
  const nameSource =
    (ownerUser && (ownerUser.displayName || ownerUser.name)) ||
    tenant.displayName ||
    org;
  const { first, last } = splitPersonName(nameSource, "Domain", "Owner");

  const base = {
    FirstName: first.slice(0, 255),
    LastName: last.slice(0, 255),
    Address1: address1.slice(0, 255),
    City: city.slice(0, 50),
    StateProvince: state.slice(0, 50),
    PostalCode: postal.slice(0, 50),
    Country: "US",
    Phone: phone,
    EmailAddress: email.slice(0, 255),
    OrganizationName: org.slice(0, 255),
  };
  if (address2) base.Address2 = address2.slice(0, 255);

  const roles = ["Registrant", "Tech", "Admin", "AuxBilling"];
  const params = {};
  for (const role of roles) {
    for (const [k, v] of Object.entries(base)) {
      params[`${role}${k}`] = v;
    }
  }
  return params;
}

function parseDomainCreateSuccess(xmlText) {
  const registered = /Registered="true"/i.test(xmlText || "");
  const domainId = /DomainID="(\d+)"/i.exec(xmlText || "");
  const orderId = /OrderID="(\d+)"/i.exec(xmlText || "");
  const charged = /ChargedAmount="([^"]+)"/i.exec(xmlText || "");
  return {
    registered,
    domainId: domainId ? domainId[1] : null,
    orderId: orderId ? orderId[1] : null,
    chargedAmount: charged ? charged[1] : null,
  };
}

async function assertTenantOwner(uid, tenantId) {
  const tenantDoc = await getDb().collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const ownerUid = (tenantDoc.data().ownerUid || "").toString();
  if (!ownerUid || ownerUid !== uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the studio owner can manage the custom domain."
    );
  }
  return tenantDoc;
}

async function resolveUidTenant(uid) {
  const userDoc = await getDb().collection("users").doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError("failed-precondition", "User profile not found");
  }
  const tenantId = (userDoc.data().tenantId || "").toString().trim();
  if (!tenantId) {
    throw new functions.https.HttpsError("failed-precondition", "No business linked to this account");
  }
  return tenantId;
}

/**
 * After buy/transfer: wipe Design media/copy/colors back to a blank starter template,
 * keeping identity prefills (business name, industry theme, contact, location).
 * Old hand-built sites are never imported — only the Bookking app site remains.
 */
function blankSiteDesignPatch(tenant) {
  const del = admin.firestore.FieldValue.delete();
  const businessName = (tenant.businessName || tenant.displayName || "").toString().trim();
  const industry = (tenant.industry || "custom").toString().trim();
  const templatePreset = (tenant.templatePreset || "portfolio").toString().trim() || "portfolio";
  const webThemeId = resolveWebThemeId(industry, templatePreset);

  return {
    displayName: businessName || "",
    webThemeId,
    resolvedWebThemeId: webThemeId,
    templatePreset,
    aboutText: "",
    heroTagline: "",
    heroSubtitle: "",
    tagline: "",
    contactAddress: (tenant.contactAddress || "").toString(),
    contactAddressSuite: (tenant.contactAddressSuite || "").toString(),
    galleryGridLayout: "3x1",
    galleryLayoutStyle: "classic_grid",
    galleryImages: [],
    featuredWorkImages: [],

    logoUrl: del,
    heroImageUrl: del,
    heroImagePixelWidth: del,
    heroImagePixelHeight: del,
    studio12PhilosophyImageUrl: del,
    studio12PhilosophyImagePixelWidth: del,
    studio12PhilosophyImagePixelHeight: del,
    studio12BookCtaImageUrl: del,
    studio12BookCtaImagePixelWidth: del,
    studio12BookCtaImagePixelHeight: del,

    webColorPaletteId: del,
    webCopyOverrides: del,
    backgroundColor: del,
    cardSurfaceColor: del,
    textColor: del,
    primaryColor: del,
    primaryColorHover: del,
    successColor: del,
    cardBorderRadius: del,
    featuredWorkBackgroundColor: del,
    featuredWorkTextColor: del,
    bookingFormCardBackgroundColor: del,
    galleryPageBackgroundColor: del,
    galleryPageTextColor: del,
    aboutSectionBackgroundColor: del,
    aboutSectionTextColor: del,
    sidebarIconColorHome: del,
    sidebarIconColorBooking: del,

    luxeHeroTagline: del,
    luxePromoHeadline: del,
    luxeFeaturedWorkEyebrow: del,
    luxeFeaturedWorkHeading: del,
    luxeShowFeaturedWorkStrip: del,
    luxeHomeServicesEyebrow: del,
    luxeHomeServicesHeading: del,
    luxeShowHomeServicesSection: del,
    luxeHomeServicesExpandableCard: del,
    bladeHeroTagline: del,
    bladeHeroDescription: del,
    studio12HeroEyebrow: del,
    studio12HeroHeadline: del,
    studio12HeroLine1: del,
    studio12HeroLine2: del,
    studio12PhilosophyHeadline: del,
    studio12PhilosophyHeadLine1: del,
    studio12PhilosophyHeadLine2: del,
    studio12PhilosophyHeadItalic: del,
    studio12BookCtaHeadline: del,
    studio12BookCtaLine1: del,
    studio12BookCtaItalic: del,
    studio12BookCtaBody: del,
    studio12ShowServicesSection: del,
    studio12ShowProcessSection: del,
    studio12ProcessSteps: del,
    classicShowServiceDuration: del,
    classicFeaturedWorkEyebrow: del,
    classicFeaturedWorkHeading: del,
    classicFeaturedWorkSub: del,
    classicFeaturedWorkEmpty: del,
    classicServicesEyebrow: del,
    classicServicesHeading: del,
    classicServicesExpandableCard: del,
    classicShowAboutStats: del,
    classicStatYearsValue: del,
    classicStatYearsLabel: del,
    classicStatClientsValue: del,
    classicStatClientsLabel: del,
    classicStatRatedValue: del,
    classicStatRatedLabel: del,
    classicAboutEyebrow: del,
    classicAboutHeading: del,
    galleryCategories: del,
    heroFont: del,

    customDomainSiteResetAt: admin.firestore.FieldValue.serverTimestamp(),
    customDomainSiteResetReason: "custom_domain",
  };
}

async function applyBlankSiteDesign(tenantId, tenant) {
  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .set(blankSiteDesignPatch(tenant || {}), { merge: true });
}

function statusPayload(tenant, tenantId, extras) {
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  const status = (tenant.customDomainStatus || "").toString().trim() || (domain ? "unknown" : "none");
  const source = (tenant.customDomainSource || "").toString().trim() || null;
  const subdomain = (tenant.slug || "").toString().trim().toLowerCase();
  const configured = namecheapConfigured();
  const sandbox = isSandboxHost();
  const statusLower = status.toLowerCase();
  const hasDomain = !!domain && statusLower !== "none";

  const subdomainHttps = {
    status: "active",
    label: "HTTPS on",
    detail: "Your free Bookking link is always served over HTTPS.",
    url: subdomain ? `https://${subdomain}.getbookking.com` : null,
  };

  let customHttps = {
    status: "none",
    label: "Not connected",
    detail: "Connect a domain to show HTTPS for your custom address.",
    url: null,
  };
  if (hasDomain) {
    if (statusLower === "active") {
      customHttps = sandbox
        ? {
            status: "pending",
            label: "HTTPS pending",
            detail:
              "Sandbox domains don’t get public DNS yet. On live Bookking, HTTPS activates when the domain points at us.",
            url: `https://${domain}`,
          }
        : {
            status: "active",
            label: "HTTPS on",
            detail: "Visitors see a secure padlock when DNS is live on Bookking.",
            url: `https://${domain}`,
          };
    } else if (["transferring", "purchasing", "pending", "pending_dns"].includes(statusLower)) {
      customHttps = {
        status: "pending",
        label: "HTTPS pending",
        detail: "SSL activates after the domain finishes connecting to Bookking.",
        url: `https://${domain}`,
      };
    }
  }

  const base = {
    ok: true,
    tenantId,
    slug: subdomain || null,
    subdomainUrl: subdomain ? `https://${subdomain}.getbookking.com` : null,
    domain: domain || null,
    wwwDomain: domain ? wwwOf(domain) : null,
    status,
    source,
    statusMessage: (tenant.customDomainStatusMessage || "").toString() || null,
    namecheapConfigured: configured,
    providerConfigured: configured,
    canBuyOrTransfer: configured,
    connectMode: "namecheap_only",
    sandbox,
    reassurance: {
      subdomainHttps,
      customDomainHttps: customHttps,
      dnsManaged: hasDomain,
      dnsManagedLabel: hasDomain
        ? "DNS managed by Bookking — you don’t edit records"
        : "Buy or transfer a domain and we manage DNS for you",
      whoisPrivacy: extras && typeof extras.whoisPrivacy === "boolean" ? extras.whoisPrivacy : hasDomain,
      whoisPrivacyLabel: hasDomain
        ? "WHOIS privacy on (keeps your contact details private)"
        : "WHOIS privacy included when you buy or transfer here",
      autoRenew: hasDomain ? tenant.customDomainAutoRenew !== false : true,
      autoRenewLabel: hasDomain
        ? tenant.customDomainAutoRenew === false
          ? "Off — domain won’t renew automatically"
          : "On — we’ll renew before it expires"
        : "Choose auto-renew when you buy or transfer",
      expiresAt: (extras && extras.expiresAt) || null,
      createdAt: (extras && extras.createdAt) || null,
      registrarLock: (extras && extras.registrarLock) || null,
      registrarLockLabel:
        extras && extras.registrarLock === false
          ? "Unlocked — ready to transfer out"
          : hasDomain
            ? "Registrar lock on (protects against unauthorized transfers)"
            : null,
      transferOutPrepared: !!(tenant.customDomainTransferOutPreparedAt),
    },
    autoRenew: hasDomain ? tenant.customDomainAutoRenew !== false : true,
  };
  return base;
}

function parseAutoRenewFlag(raw) {
  if (typeof raw === "boolean") return raw;
  if (raw == null) return true;
  const s = String(raw).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(s)) return false;
  if (["1", "true", "yes", "on"].includes(s)) return true;
  return true;
}

/**
 * Best-effort Namecheap auto-renew (API is undocumented; preference always stored on tenant).
 */
async function maybeSetNamecheapAutoRenew(domain, enabled) {
  if (!domain) return false;
  try {
    const raw = await namecheapRequest("namecheap.domains.setAutoRenew", {
      DomainName: domain,
      AutoRenew: enabled ? "true" : "false",
    });
    if (namecheapStatusOk(raw)) return true;
    console.warn(
      "setAutoRenew not OK",
      namecheapErrorMessage(raw) || (raw || "").slice(0, 200)
    );
  } catch (e) {
    console.warn("setAutoRenew failed", e.message || e);
  }
  return false;
}

async function fetchNamecheapAutoRenew(domain) {
  if (!domain) return null;
  try {
    const raw = await namecheapRequest("namecheap.domains.getList", {
      SearchTerm: domain,
      PageSize: "50",
    });
    if (!namecheapStatusOk(raw)) return null;
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<Domain[^>]*Name="${escaped}"[^>]*AutoRenew="(true|false)"[^>]*/?>`,
      "i"
    );
    const re2 = new RegExp(
      `<Domain[^>]*AutoRenew="(true|false)"[^>]*Name="${escaped}"[^>]*/?>`,
      "i"
    );
    const m = re.exec(raw || "") || re2.exec(raw || "");
    if (m) return /^true$/i.test(m[1]);
  } catch (e) {
    console.warn("getList AutoRenew failed", e.message || e);
  }
  return null;
}

function parseDomainGetInfo(xmlText) {
  const expires =
    /<ExpiredDate>([^<]+)<\/ExpiredDate>/i.exec(xmlText || "") ||
    /ExpiredDate="([^"]+)"/i.exec(xmlText || "");
  const created =
    /<CreatedDate>([^<]+)<\/CreatedDate>/i.exec(xmlText || "") ||
    /CreatedDate="([^"]+)"/i.exec(xmlText || "");
  const whois =
    /Whoisguard[^>]*Enabled="(True|False|true|false)"/i.exec(xmlText || "") ||
    /<Whoisguard[^>]*Enabled="(True|False|true|false)"/i.exec(xmlText || "");
  const status =
    /DomainGetInfoResult[^>]*Status="([^"]+)"/i.exec(xmlText || "") ||
    /Status="(Ok|Locked|Expired)"/i.exec(xmlText || "");
  return {
    expiresAt: expires ? expires[1].trim() : null,
    createdAt: created ? created[1].trim() : null,
    whoisPrivacy: whois ? /^true$/i.test(whois[1]) : null,
    domainStatus: status ? status[1].trim() : null,
  };
}

function parseRegistrarLock(xmlText) {
  // <DomainGetRegistrarLockResult ... RegistrarLockStatus="true"
  const m =
    /RegistrarLockStatus="(true|false)"/i.exec(xmlText || "") ||
    /<RegistrarLockStatus>(true|false)<\/RegistrarLockStatus>/i.exec(xmlText || "");
  if (!m) return null;
  return /^true$/i.test(m[1]);
}

async function fetchDomainReassuranceExtras(domain) {
  if (!domain || !namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
    return {};
  }
  const extras = {};
  try {
    const infoRaw = await namecheapRequest("namecheap.domains.getInfo", {
      DomainName: domain,
    });
    if (namecheapStatusOk(infoRaw)) {
      const info = parseDomainGetInfo(infoRaw);
      if (info.expiresAt) extras.expiresAt = info.expiresAt;
      if (info.createdAt) extras.createdAt = info.createdAt;
      if (typeof info.whoisPrivacy === "boolean") extras.whoisPrivacy = info.whoisPrivacy;
    }
  } catch (e) {
    console.warn("domains.getInfo failed", e.message || e);
  }
  try {
    const { sld, tld } = splitSldTld(domain);
    if (sld && tld) {
      const lockRaw = await namecheapRequest("namecheap.domains.getRegistrarLock", {
        DomainName: domain,
      });
      if (namecheapStatusOk(lockRaw)) {
        const locked = parseRegistrarLock(lockRaw);
        if (typeof locked === "boolean") extras.registrarLock = locked;
      }
    }
  } catch (e) {
    console.warn("domains.getRegistrarLock failed", e.message || e);
  }
  const ncAuto = await fetchNamecheapAutoRenew(domain);
  if (typeof ncAuto === "boolean") extras.autoRenew = ncAuto;
  return extras;
}

async function writeDomainMappings({ domain, tenantId, slug, status, source }) {
  const batch = getDb().batch();
  const apexRef = getDb().collection("domainMappings").doc(hostDocId(domain));
  const wwwRef = getDb().collection("domainMappings").doc(hostDocId(wwwOf(domain)));
  const base = {
    host: hostDocId(domain),
    tenantId,
    slug,
    status,
    source: source || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  batch.set(apexRef, base, { merge: true });
  batch.set(
    wwwRef,
    {
      ...base,
      host: hostDocId(wwwOf(domain)),
    },
    { merge: true }
  );
  await batch.commit();
}

async function clearDomainMappings(domain) {
  if (!domain) return;
  const batch = getDb().batch();
  batch.delete(getDb().collection("domainMappings").doc(hostDocId(domain)));
  batch.delete(getDb().collection("domainMappings").doc(hostDocId(wwwOf(domain))));
  await batch.commit();
}

async function assertDomainAvailableForTenant(domain, tenantId) {
  const apex = await getDb().collection("domainMappings").doc(hostDocId(domain)).get();
  if (apex.exists) {
    const data = apex.data() || {};
    if ((data.tenantId || "") !== tenantId && (data.status || "") !== "none") {
      throw new functions.https.HttpsError(
        "already-exists",
        "That domain is already connected to another Bookking business."
      );
    }
  }
}

async function maybeSetCustomNameservers(domain) {
  const ns1 = (namecheapNameserver1.value() || "").trim();
  const ns2 = (namecheapNameserver2.value() || "").trim();
  if (!ns1 || !ns2) return;
  const { sld, tld } = splitSldTld(domain);
  if (!sld || !tld) return;
  try {
    await namecheapRequest("namecheap.domains.dns.setCustom", {
      SLD: sld,
      TLD: tld,
      Nameservers: `${ns1},${ns2}`,
    });
  } catch (e) {
    console.warn("setCustom nameservers failed (may apply after transfer completes)", e.message || e);
  }
}

async function fulfillDomainPurchase({ uid, tenantId, tenant, domain, payment, autoRenew }) {
  const slug = (tenant.slug || "").toString().trim().toLowerCase();
  if (!slug) {
    throw new functions.https.HttpsError("failed-precondition", "Business slug is missing");
  }

  const checkRaw = await namecheapRequest("namecheap.domains.check", {
    DomainList: domain,
  });
  if (!namecheapStatusOk(checkRaw)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      namecheapErrorMessage(checkRaw) || "Could not verify domain availability."
    );
  }
  if (parseDomainCheckAvailable(checkRaw, domain) === false) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `${domain} is not available to buy. Transfer it instead if you own it.`
    );
  }

  const ownerSnap = await getDb().collection("users").doc(uid).get();
  const ownerUser = ownerSnap.exists ? ownerSnap.data() || {} : {};
  const contacts = buildDomainContactParams(tenant, ownerUser);
  const createRaw = await namecheapRequest("namecheap.domains.create", {
    DomainName: domain,
    Years: "1",
    AddFreeWhoisguard: "yes",
    WGEnabled: "yes",
    ...contacts,
  });
  if (!namecheapStatusOk(createRaw)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      namecheapErrorMessage(createRaw) ||
        "Payment received, but domain registration failed. Contact domainsupport@getbookking.com."
    );
  }
  const created = parseDomainCreateSuccess(createRaw);
  if (!created.registered) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Payment received, but domain was not registered. Contact domainsupport@getbookking.com."
    );
  }

  await maybeSetCustomNameservers(domain);
  const wantAutoRenew = autoRenew !== false;
  await maybeSetNamecheapAutoRenew(domain, wantAutoRenew);
  const status = "active";
  const statusMessage = isSandboxHost()
    ? "Registered in Namecheap sandbox (test). Open Design to build your blank Get Bookking site."
    : "Domain registered. Open Design to build your site — we’ll finish DNS next.";

  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .set(
      {
        customDomain: domain,
        customDomainWww: wwwOf(domain),
        customDomainStatus: status,
        customDomainSource: "purchase",
        customDomainProvider: "namecheap",
        customDomainOrderId: created.orderId || null,
        customDomainNamecheapId: created.domainId || null,
        customDomainStatusMessage: statusMessage,
        customDomainStripePaymentIntentId: (payment && payment.paymentIntentId) || null,
        customDomainCustomerPaidUsd: (payment && payment.customerPaidUsd) || null,
        customDomainWholesaleUsd: (payment && payment.wholesaleUsd) || null,
        customDomainAutoRenew: wantAutoRenew,
        customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...blankSiteDesignPatch(tenant),
      },
      { merge: true }
    );

  await writeDomainMappings({
    domain,
    tenantId,
    slug,
    status,
    source: "purchase",
  });

  return {
    ok: true,
    domain,
    status,
    sandbox: isSandboxHost(),
    siteReset: true,
    orderId: created.orderId,
    chargedAmount: created.chargedAmount,
    customerPaidUsd: payment && payment.customerPaidUsd,
    message: isSandboxHost()
      ? `${domain} is yours in sandbox. Design is reset to a blank template — open Design to build.`
      : `${domain} purchased. Design is reset to a blank template — open Design to build.`,
    subdomainUrl: `https://${slug}.getbookking.com`,
    publicUrl: `https://${domain}`,
  };
}

async function fulfillDomainTransfer({ tenantId, tenant, domain, authCode, payment, autoRenew }) {
  const slug = (tenant.slug || "").toString().trim().toLowerCase();
  if (!slug) {
    throw new functions.https.HttpsError("failed-precondition", "Business slug is missing");
  }

  const transferRaw = await namecheapRequest("namecheap.domains.transfer.create", {
    DomainName: domain,
    Years: "1",
    EPPCode: encodeEppCode(authCode),
    AddFreeWhoisguard: "yes",
    WGenable: "yes",
  });

  if (!namecheapStatusOk(transferRaw)) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      namecheapErrorMessage(transferRaw) ||
        "Payment received, but transfer could not start. Contact domainsupport@getbookking.com."
    );
  }

  const transferIdMatch = /TransferID="(\d+)"/i.exec(transferRaw);
  const transferId = transferIdMatch ? transferIdMatch[1] : null;

  const wantAutoRenew = autoRenew !== false;
  // Transfer may still be pending; preference is stored and applied when active / via settings.
  await maybeSetNamecheapAutoRenew(domain, wantAutoRenew);

  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .set(
      {
        customDomain: domain,
        customDomainWww: wwwOf(domain),
        customDomainStatus: "transferring",
        customDomainSource: "transfer",
        customDomainProvider: "namecheap",
        customDomainTransferId: transferId || null,
        customDomainStatusMessage:
          "Transfer started. Design is reset to a blank template — build in the app while the transfer completes.",
        customDomainStripePaymentIntentId: (payment && payment.paymentIntentId) || null,
        customDomainCustomerPaidUsd: (payment && payment.customerPaidUsd) || null,
        customDomainWholesaleUsd: (payment && payment.wholesaleUsd) || null,
        customDomainAutoRenew: wantAutoRenew,
        customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...blankSiteDesignPatch(tenant),
      },
      { merge: true }
    );

  await writeDomainMappings({
    domain,
    tenantId,
    slug,
    status: "transferring",
    source: "transfer",
  });
  await maybeSetCustomNameservers(domain);

  return {
    ok: true,
    domain,
    status: "transferring",
    siteReset: true,
    transferId,
    customerPaidUsd: payment && payment.customerPaidUsd,
    message:
      "Transfer started. Design is reset to a blank template — open Design to build. Approve any email from your old registrar; we’ll connect the domain when the transfer finishes.",
    publicUrl: `https://${domain}`,
  };
}

async function createPendingDomainPayment({
  uid,
  tenantId,
  kind,
  domain,
  authCode,
  customerPrice,
  wholesale,
  amountCents: amountCentsOverride,
  baseCents,
  feeCents,
  platformFeeCents,
  autoRenew,
}) {
  const stripe = getStripe();
  const amountCents =
    amountCentsOverride != null
      ? Math.max(50, Math.round(Number(amountCentsOverride)))
      : dollarsToCents(customerPrice);
  const wantAutoRenew = autoRenew !== false;
  const pi = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    description:
      kind === "transfer"
        ? `Domain transfer-in: ${domain}`
        : `Domain registration: ${domain}`,
    metadata: {
      paymentKind: kind === "transfer" ? "domain_transfer" : "domain_purchase",
      checkoutKind: kind === "transfer" ? "domain_transfer" : "domain_purchase",
      firebaseUid: uid,
      tenantId,
      domain,
      wholesaleUsd: String(wholesale),
      customerUsd: String(customerPrice),
      baseCents: baseCents != null ? String(baseCents) : "",
      feeCents: feeCents != null ? String(feeCents) : "",
      platformFeeCents: platformFeeCents != null ? String(platformFeeCents) : "",
      autoRenew: wantAutoRenew ? "true" : "false",
    },
  });

  await getDb()
    .collection("pendingDomainOrders")
    .doc(pi.id)
    .set({
      paymentIntentId: pi.id,
      kind: kind === "transfer" ? "transfer" : "purchase",
      domain,
      authCode: kind === "transfer" ? authCode : null,
      tenantId,
      uid,
      wholesaleUsd: wholesale,
      customerUsd: customerPrice,
      baseCents: baseCents != null ? baseCents : null,
      feeCents: feeCents != null ? feeCents : null,
      platformFeeCents: platformFeeCents != null ? platformFeeCents : null,
      amountCents,
      autoRenew: wantAutoRenew,
      status: "requires_payment",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  return {
    clientSecret: pi.client_secret,
    paymentIntentId: pi.id,
    publishableKey: (stripePublishableKeyParam.value() || "").trim() || null,
    amountCents,
    customerPriceUsd: customerPrice,
    wholesaleUsd: wholesale,
    markup: readMarkupConfig(),
    domain,
    kind: kind === "transfer" ? "transfer" : "purchase",
    autoRenew: wantAutoRenew,
  };
}

/**
 * After Stripe PaymentIntent succeeds — register/transfer at Namecheap.
 * Idempotent if tenant already has this domain connected.
 */
async function fulfillDomainPaymentIntent(paymentIntentId, opts) {
  const piId = (paymentIntentId || "").toString().trim();
  if (!piId) return null;

  const orderRef = getDb().collection("pendingDomainOrders").doc(piId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) {
    return null;
  }
  const order = orderSnap.data() || {};
  if (order.status === "fulfilled") {
    return { ok: true, alreadyFulfilled: true, domain: order.domain };
  }

  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId);
  if (pi.status !== "succeeded") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Payment has not completed yet."
    );
  }

  const tenantId = (order.tenantId || "").toString();
  const uid = (order.uid || (opts && opts.uid) || "").toString();
  const domain = normalizeDomain(order.domain);
  const tenantDoc = await getDb().collection("tenants").doc(tenantId).get();
  if (!tenantDoc.exists) {
    throw new functions.https.HttpsError("not-found", "Business not found");
  }
  const tenant = tenantDoc.data() || {};

  // Idempotent if already attached
  const existing = (tenant.customDomain || "").toString().trim().toLowerCase();
  const existingStatus = (tenant.customDomainStatus || "").toString().trim().toLowerCase();
  if (
    existing === domain &&
    (existingStatus === "active" || existingStatus === "transferring") &&
    (tenant.customDomainStripePaymentIntentId || "") === piId
  ) {
    await orderRef.set(
      { status: "fulfilled", fulfilledAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { ok: true, alreadyFulfilled: true, domain };
  }

  const payment = {
    paymentIntentId: piId,
    customerPaidUsd: order.customerUsd,
    wholesaleUsd: order.wholesaleUsd,
  };
  const autoRenew = parseAutoRenewFlag(order.autoRenew);

  let result;
  if (order.kind === "transfer") {
    const authCode = (order.authCode || "").toString();
    result = await fulfillDomainTransfer({
      tenantId,
      tenant,
      domain,
      authCode,
      payment,
      autoRenew,
    });
  } else {
    result = await fulfillDomainPurchase({
      uid,
      tenantId,
      tenant,
      domain,
      payment,
      autoRenew,
    });
  }

  await orderRef.set(
    {
      status: "fulfilled",
      fulfilledAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return result;
}

function registerCustomDomainFunctions(exportsObj) {
  exportsObj.getCustomDomainStatus = functions
    .runWith({ secrets: [namecheapApiKey] })
    .https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required");
    }
    const tenantId = await resolveUidTenant(context.auth.uid);
    let tenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
    let tenant = tenantDoc.data() || {};

    // Backfill: domains bought before blank-site reset existed.
    const status = (tenant.customDomainStatus || "").toString().trim().toLowerCase();
    const hasDomain = !!(tenant.customDomain || "").toString().trim();
    const alreadyReset = !!tenant.customDomainSiteResetAt;
    if (hasDomain && ["active", "transferring", "purchasing", "pending"].includes(status) && !alreadyReset) {
      await applyBlankSiteDesign(tenantId, tenant);
      tenantDoc = await getDb().collection("tenants").doc(tenantId).get();
      tenant = tenantDoc.data() || {};
    }

    let extras = {};
    const domainName = (tenant.customDomain || "").toString().trim().toLowerCase();
    if (
      domainName &&
      ["active", "transferring"].includes((tenant.customDomainStatus || "").toString().toLowerCase())
    ) {
      try {
        extras = await fetchDomainReassuranceExtras(domainName);
      } catch (e) {
        console.warn("reassurance extras failed", e.message || e);
      }
    }

    return statusPayload(tenant, tenantId, extras);
  });

  exportsObj.checkDomainAvailability = functions
    .runWith({ secrets: [namecheapApiKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const tenantId = await resolveUidTenant(context.auth.uid);
      await assertTenantOwner(context.auth.uid, tenantId);

      const domain = normalizeDomain(data && data.domain);
      if (!isValidDomain(domain)) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a valid domain like yourbusiness.com"
        );
      }

      if (!namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
        return {
          ok: true,
          domain,
          available: null,
          namecheapConfigured: false,
          providerConfigured: false,
          message:
            "Domain buy/transfer will unlock once Namecheap API is connected. Your free subdomain still works.",
        };
      }

      await assertDomainAvailableForTenant(domain, tenantId);

      const raw = await namecheapRequest("namecheap.domains.check", {
        DomainList: domain,
      });
      if (!namecheapStatusOk(raw)) {
        return {
          ok: true,
          domain,
          available: null,
          namecheapConfigured: true,
          providerConfigured: true,
          message: namecheapErrorMessage(raw),
        };
      }
      const available = parseDomainCheckAvailable(raw, domain);

      return {
        ok: true,
        domain,
        available,
        namecheapConfigured: true,
        providerConfigured: true,
        message:
          available == null
            ? "Could not check availability. Try again."
            : available
              ? `${domain} is available to buy in Bookking.`
              : `${domain} is registered. Transfer it to Bookking to connect automatically.`,
      };
    });

  /**
   * Search domains by name: availability + Namecheap wholesale + customer price (markup).
   * data.query: "mystudio" or "mystudio.com"
   */
  exportsObj.searchDomains = functions
    .runWith({ secrets: [namecheapApiKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const tenantId = await resolveUidTenant(context.auth.uid);
      await assertTenantOwner(context.auth.uid, tenantId);

      const query = normalizeSearchQuery(data && data.query);
      if (!query || query.length < 1) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a name like mystudio or mystudio.com"
        );
      }

      const markup = readMarkupConfig();
      if (!namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
        return {
          ok: true,
          query,
          results: [],
          providerConfigured: false,
          canBuyOrTransfer: false,
          markup,
          message:
            "Domain search unlocks once Namecheap API is connected. Your free subdomain still works.",
        };
      }

      const domainList = buildSearchDomainList(query);
      if (!domainList.length) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a valid name (letters, numbers, hyphens)."
        );
      }

      const [checkRaw, registerPricingAttempt, transferPricingAttempt] = await Promise.all([
        namecheapRequest("namecheap.domains.check", {
          DomainList: domainList.join(","),
        }),
        namecheapRequest("namecheap.users.getPricing", {
          ProductType: "DOMAIN",
          ActionName: "REGISTER",
        }).catch((e) => {
          console.warn("getPricing REGISTER failed", e.message || e);
          return "";
        }),
        namecheapRequest("namecheap.users.getPricing", {
          ProductType: "DOMAIN",
          ActionName: "TRANSFER",
        }).catch((e) => {
          console.warn("getPricing TRANSFER failed", e.message || e);
          return "";
        }),
      ]);

      if (!namecheapStatusOk(checkRaw)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          namecheapErrorMessage(checkRaw) || "Could not search domains. Try again."
        );
      }

      // Pricing may ERROR on some sandbox accounts; still return availability with fallbacks.
      const registerPricingRaw = namecheapStatusOk(registerPricingAttempt)
        ? registerPricingAttempt
        : "";
      const transferPricingRaw = namecheapStatusOk(transferPricingAttempt)
        ? transferPricingAttempt
        : "";

      const checks = parseAllDomainChecks(checkRaw);
      const results = domainList.map((domain) => {
        const { tld } = splitSldTld(domain);
        const check = checks[domain] || {};
        const available = typeof check.available === "boolean" ? check.available : null;
        const wholesaleRegister =
          parseTldPriceFromPricingXml(registerPricingRaw, tld, "REGISTER") ??
          FALLBACK_REGISTER_USD[tld] ??
          null;
        const wholesaleTransfer =
          parseTldPriceFromPricingXml(transferPricingRaw, tld, "TRANSFER") ??
          FALLBACK_TRANSFER_USD[tld] ??
          null;
        const customerRegister = applyCustomerMarkup(wholesaleRegister);
        const customerTransfer = applyCustomerMarkup(wholesaleTransfer);
        return {
          domain,
          tld,
          available,
          premium: check.premium === true,
          wholesaleRegisterUsd: wholesaleRegister,
          wholesaleTransferUsd: wholesaleTransfer,
          registerPriceUsd: customerRegister,
          transferPriceUsd: customerTransfer,
          registerPriceLabel: formatMoneyLabel(customerRegister),
          transferPriceLabel: formatMoneyLabel(customerTransfer),
          statusLabel:
            available === true
              ? "Available"
              : available === false
                ? "Taken — transfer"
                : "Unknown",
        };
      });

      return {
        ok: true,
        query,
        results,
        providerConfigured: true,
        canBuyOrTransfer: true,
        markup,
        message: null,
      };
    });

  /** Create Stripe PaymentIntent (platform) for domain buy — marked-up price → Get Bookking Stripe. */
  exportsObj.startDomainPurchase = functions
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const uid = context.auth.uid;
      const tenantId = await resolveUidTenant(uid);
      const tenantDoc = await assertTenantOwner(uid, tenantId);
      const tenant = tenantDoc.data() || {};
      const slug = (tenant.slug || "").toString().trim().toLowerCase();
      if (!slug) {
        throw new functions.https.HttpsError("failed-precondition", "Business slug is missing");
      }

      const domain = normalizeDomain(data && data.domain);
      if (!isValidDomain(domain)) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a valid domain like yourbusiness.com"
        );
      }
      if (!namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Domain purchases are not enabled yet. Namecheap API credentials are required."
        );
      }

      await assertDomainAvailableForTenant(domain, tenantId);
      const existing = (tenant.customDomain || "").toString().trim().toLowerCase();
      if (existing && existing !== domain && (tenant.customDomainStatus || "") === "active") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Remove your current connected domain before buying another."
        );
      }

      const checkRaw = await namecheapRequest("namecheap.domains.check", {
        DomainList: domain,
      });
      if (!namecheapStatusOk(checkRaw)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          namecheapErrorMessage(checkRaw) || "Could not verify domain availability."
        );
      }
      if (parseDomainCheckAvailable(checkRaw, domain) === false) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `${domain} is not available to buy. Transfer it instead if you own it.`
        );
      }

      const pricing = await resolveCustomerDomainPrice(domain, "REGISTER");
      const autoRenew = parseAutoRenewFlag(data && data.autoRenew);
      const payment = await createPendingDomainPayment({
        uid,
        tenantId,
        kind: "purchase",
        domain,
        customerPrice: pricing.customer,
        wholesale: pricing.wholesale,
        amountCents: pricing.totalCents,
        baseCents: pricing.baseCents,
        feeCents: 0,
        platformFeeCents: 0,
        autoRenew,
      });

      return {
        ok: true,
        needsPayment: true,
        ...payment,
        message: `Pay ${formatMoneyLabel(pricing.customer)} to register ${domain}.`,
      };
    });

  exportsObj.completeDomainPurchase = functions
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const paymentIntentId = ((data && data.paymentIntentId) || "").toString().trim();
      if (!paymentIntentId) {
        throw new functions.https.HttpsError("invalid-argument", "paymentIntentId is required");
      }
      const orderSnap = await getDb().collection("pendingDomainOrders").doc(paymentIntentId).get();
      if (!orderSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Payment order not found");
      }
      const order = orderSnap.data() || {};
      if (order.uid !== context.auth.uid) {
        throw new functions.https.HttpsError("permission-denied", "Not your payment");
      }
      if (order.kind !== "purchase") {
        throw new functions.https.HttpsError("failed-precondition", "Not a purchase order");
      }
      return fulfillDomainPaymentIntent(paymentIntentId, { uid: context.auth.uid });
    });

  /** Create Stripe PaymentIntent for transfer-in fee (marked up). No transfer-out fee. */
  exportsObj.startDomainTransfer = functions
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const uid = context.auth.uid;
      const tenantId = await resolveUidTenant(uid);
      const tenantDoc = await assertTenantOwner(uid, tenantId);
      const tenant = tenantDoc.data() || {};
      const slug = (tenant.slug || "").toString().trim().toLowerCase();
      if (!slug) {
        throw new functions.https.HttpsError("failed-precondition", "Business slug is missing");
      }

      const domain = normalizeDomain(data && data.domain);
      const authCode = ((data && data.authCode) || "").toString().trim();
      if (!isValidDomain(domain)) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a valid domain like yourbusiness.com"
        );
      }
      if (!authCode || authCode.length < 4) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Paste the authorization / EPP code from your current registrar."
        );
      }
      if (!namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Domain transfers are not enabled yet. Namecheap API credentials are required."
        );
      }

      await assertDomainAvailableForTenant(domain, tenantId);
      const existing = (tenant.customDomain || "").toString().trim().toLowerCase();
      if (existing && existing !== domain && (tenant.customDomainStatus || "") === "active") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Remove your current connected domain before transferring another."
        );
      }

      const pricing = await resolveCustomerDomainPrice(domain, "TRANSFER");
      const autoRenew = parseAutoRenewFlag(data && data.autoRenew);
      const payment = await createPendingDomainPayment({
        uid,
        tenantId,
        kind: "transfer",
        domain,
        authCode,
        customerPrice: pricing.customer,
        wholesale: pricing.wholesale,
        amountCents: pricing.totalCents,
        baseCents: pricing.baseCents,
        feeCents: 0,
        platformFeeCents: 0,
        autoRenew,
      });

      return {
        ok: true,
        needsPayment: true,
        ...payment,
        message: `Pay ${formatMoneyLabel(pricing.customer)} to transfer ${domain} into Get Bookking.`,
      };
    });

  exportsObj.completeDomainTransfer = functions
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const paymentIntentId = ((data && data.paymentIntentId) || "").toString().trim();
      if (!paymentIntentId) {
        throw new functions.https.HttpsError("invalid-argument", "paymentIntentId is required");
      }
      const orderSnap = await getDb().collection("pendingDomainOrders").doc(paymentIntentId).get();
      if (!orderSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Payment order not found");
      }
      const order = orderSnap.data() || {};
      if (order.uid !== context.auth.uid) {
        throw new functions.https.HttpsError("permission-denied", "Not your payment");
      }
      if (order.kind !== "transfer") {
        throw new functions.https.HttpsError("failed-precondition", "Not a transfer order");
      }
      return fulfillDomainPaymentIntent(paymentIntentId, { uid: context.auth.uid });
    });

  exportsObj.removeCustomDomain = functions.https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required");
    }
    const tenantId = await resolveUidTenant(context.auth.uid);
    const tenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
    const tenant = tenantDoc.data() || {};
    const domain = (tenant.customDomain || "").toString().trim().toLowerCase();

    await getDb()
      .collection("tenants")
      .doc(tenantId)
      .set(
        {
          customDomain: admin.firestore.FieldValue.delete(),
          customDomainWww: admin.firestore.FieldValue.delete(),
          customDomainStatus: "none",
          customDomainSource: admin.firestore.FieldValue.delete(),
          customDomainProvider: admin.firestore.FieldValue.delete(),
          customDomainTransferId: admin.firestore.FieldValue.delete(),
          customDomainStatusMessage: admin.firestore.FieldValue.delete(),
          customDomainTransferOutPreparedAt: admin.firestore.FieldValue.delete(),
          customDomainAutoRenew: admin.firestore.FieldValue.delete(),
          customDomainAutoRenewUpdatedAt: admin.firestore.FieldValue.delete(),
          customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    await clearDomainMappings(domain);

    const slug = (tenant.slug || "").toString().trim().toLowerCase();
    return {
      ok: true,
      domain: null,
      status: "none",
      message: "Custom domain removed. Your free subdomain still works.",
      subdomainUrl: slug ? `https://${slug}.getbookking.com` : null,
    };
  });

  /**
   * Unlock domain for transfer out. Namecheap emails the EPP/auth code to the registrant —
   * the public API does not return the code in the response.
   */
  exportsObj.prepareDomainTransferOut = functions
    .runWith({ secrets: [namecheapApiKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const uid = context.auth.uid;
      const tenantId = await resolveUidTenant(uid);
      const tenantDoc = await assertTenantOwner(uid, tenantId);
      const tenant = tenantDoc.data() || {};
      const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
      const status = (tenant.customDomainStatus || "").toString().trim().toLowerCase();

      if (!domain || status === "none") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "No Bookking-managed domain to transfer out."
        );
      }
      if (status !== "active") {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Wait until the domain is fully connected before transferring out."
        );
      }
      if (!namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Domain tools are not connected yet."
        );
      }

      let unlocked = false;
      let lockError = null;
      try {
        const lockRaw = await namecheapRequest("namecheap.domains.setRegistrarLock", {
          DomainName: domain,
          LockAction: "UNLOCK",
        });
        if (namecheapStatusOk(lockRaw)) {
          unlocked = true;
        } else {
          lockError = namecheapErrorMessage(lockRaw);
        }
      } catch (e) {
        lockError = e.message || String(e);
      }

      await getDb()
        .collection("tenants")
        .doc(tenantId)
        .set(
          {
            customDomainTransferOutPreparedAt: admin.firestore.FieldValue.serverTimestamp(),
            customDomainStatusMessage: unlocked
              ? "Unlocked for transfer out. Check email for your auth code."
              : `Transfer out started. ${lockError || "Confirm unlock in Namecheap if needed."}`,
            customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

      const ownerSnap = await getDb().collection("users").doc(uid).get();
      const ownerEmail =
        (ownerSnap.exists && (ownerSnap.data().email || "").toString().trim()) ||
        (tenant.contactEmail || "").toString().trim() ||
        null;

      return {
        ok: true,
        domain,
        unlocked,
        lockError: unlocked ? null : lockError,
        authCodeDelivery: "email",
        authCodeNote:
          "Namecheap sends the authorization / EPP code to the domain admin email (often your Bookking account email). It is not shown in this app for security.",
        contactEmailHint: ownerEmail,
        steps: [
          "Check email for the authorization / EPP code (and spam).",
          "At your new registrar, start a domain transfer and paste that code.",
          "Approve any confirmation emails.",
          "When the transfer finishes, tap “I’ve left Bookking” so we disconnect the domain here.",
        ],
        message: unlocked
          ? `${domain} is unlocked. Check ${ownerEmail || "your admin email"} for the auth code, then start the transfer at your new registrar.`
          : `We couldn’t confirm unlock via API${lockError ? ` (${lockError})` : ""}. You can still request the auth code from Bookking support, or try again.`,
      };
    });

  /** Toggle auto-renew preference for the connected domain. */
  exportsObj.setCustomDomainAutoRenew = functions
    .runWith({ secrets: [namecheapApiKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const uid = context.auth.uid;
      const tenantId = await resolveUidTenant(uid);
      const tenantDoc = await assertTenantOwner(uid, tenantId);
      const tenant = tenantDoc.data() || {};
      const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
      const status = (tenant.customDomainStatus || "").toString().trim().toLowerCase();
      if (!domain || !["active", "transferring"].includes(status)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Connect a domain before changing auto-renew."
        );
      }
      const autoRenew = parseAutoRenewFlag(data && data.autoRenew);
      const ncOk = await maybeSetNamecheapAutoRenew(domain, autoRenew);
      await getDb()
        .collection("tenants")
        .doc(tenantId)
        .set(
          {
            customDomainAutoRenew: autoRenew,
            customDomainAutoRenewUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      const refreshed = (await getDb().collection("tenants").doc(tenantId).get()).data() || {};
      return {
        ...statusPayload(refreshed, tenantId, { autoRenew }),
        ok: true,
        autoRenew,
        namecheapSynced: ncOk,
        message: autoRenew
          ? "Auto-renew is on. We’ll renew before the domain expires."
          : "Auto-renew is off. Renew manually before expiry or the domain can lapse.",
      };
    });

  /** After the domain has left Namecheap / Bookking, clear tenant custom domain. */
  exportsObj.confirmDomainTransferOut = functions.https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required");
    }
    const tenantId = await resolveUidTenant(context.auth.uid);
    const tenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
    const tenant = tenantDoc.data() || {};
    const domain = (tenant.customDomain || "").toString().trim().toLowerCase();

    await getDb()
      .collection("tenants")
      .doc(tenantId)
      .set(
        {
          customDomain: admin.firestore.FieldValue.delete(),
          customDomainWww: admin.firestore.FieldValue.delete(),
          customDomainStatus: "none",
          customDomainSource: admin.firestore.FieldValue.delete(),
          customDomainProvider: admin.firestore.FieldValue.delete(),
          customDomainTransferId: admin.firestore.FieldValue.delete(),
          customDomainStatusMessage: admin.firestore.FieldValue.delete(),
          customDomainTransferOutPreparedAt: admin.firestore.FieldValue.delete(),
          customDomainAutoRenew: admin.firestore.FieldValue.delete(),
          customDomainAutoRenewUpdatedAt: admin.firestore.FieldValue.delete(),
          customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    await clearDomainMappings(domain);
    const slug = (tenant.slug || "").toString().trim().toLowerCase();
    return {
      ok: true,
      domain: null,
      status: "none",
      siteFallsBackToSubdomain: true,
      message: domain
        ? `${domain} disconnected. Your site stays on ${slug ? `${slug}.getbookking.com` : "your free Bookking link"}.`
        : "Domain disconnected. Your free Bookking link still works.",
      subdomainUrl: slug ? `https://${slug}.getbookking.com` : null,
    };
  });

  /**
   * Public resolve for Cloudflare worker / SPA fallback.
   * GET ?host=bleustattoos.com → { slug, status }
   */
  exportsObj.resolveTenantDomain = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Cache-Control", "public, max-age=60");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "GET") {
      res.status(405).json({ error: "GET only" });
      return;
    }
    let host = ((req.query && req.query.host) || "").toString().trim().toLowerCase();
    host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host || host.length > 253) {
      res.status(400).json({ error: "host required" });
      return;
    }

    const snap = await getDb().collection("domainMappings").doc(host).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, host, slug: null });
      return;
    }
    const data = snap.data() || {};
    const status = (data.status || "").toString();
    const slug = (data.slug || "").toString().trim().toLowerCase();
    if (status !== "active" || !slug) {
      res.status(404).json({ ok: false, host, slug: null, status: status || null });
      return;
    }
    res.status(200).json({ ok: true, host, slug, tenantId: data.tenantId || null, status });
  });
}

module.exports = {
  registerCustomDomainFunctions,
  normalizeDomain,
  isValidDomain,
  namecheapApiKey,
  namecheapApiUser,
  fulfillDomainPaymentIntent,
};
