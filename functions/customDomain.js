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
const dns = require("dns").promises;
const walletDomains = require("./walletDomains");

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
/** Cloudflare for SaaS: each customer domain is a custom hostname on the getbookking.com zone. */
const cloudflareApiToken = defineSecret("CLOUDFLARE_API_TOKEN");
const cloudflareZoneId = defineString("CLOUDFLARE_ZONE_ID", {
  default: "",
  description: "Zone ID of getbookking.com in Cloudflare",
});
const customDomainTarget = defineString("CUSTOM_DOMAIN_TARGET", {
  default: "domains.getbookking.com",
  description: "Address customer domains point at (Cloudflare fallback origin)",
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

/**
 * TestFlight: block domain buy/transfer (live Namecheap charges real money).
 * Set false before App Store launch when domain sales go live.
 */
const BLOCK_DOMAIN_PURCHASING_DURING_TESTFLIGHT = true;
const TESTFLIGHT_DOMAIN_PURCHASE_BLOCK_MESSAGE = "Unavailable.";

/** A shop with `domainPurchaseBlockExempt` (set by scripts/set-shop-access.js) may buy while blocked. */
function isDomainPurchasingBlockedDuringTestFlight(tenant) {
  if (BLOCK_DOMAIN_PURCHASING_DURING_TESTFLIGHT !== true) return false;
  return !(tenant && tenant.domainPurchaseBlockExempt === true);
}

function domainPurchaseBlockReason(tenant) {
  if (isDomainPurchasingBlockedDuringTestFlight(tenant)) {
    return TESTFLIGHT_DOMAIN_PURCHASE_BLOCK_MESSAGE;
  }
  return null;
}

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
  const tags = (xmlText || "").match(/<DomainCheckResult\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attr = (name) => {
      const m = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag);
      return m ? m[1] : "";
    };
    const domain = attr("Domain").toLowerCase();
    if (!domain) continue;
    out[domain] = {
      available: attr("Available").toLowerCase() === "true",
      premium: attr("IsPremiumName").toLowerCase() === "true",
    };
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
  const requested = (action || "REGISTER").toUpperCase();
  const actionName = ["TRANSFER", "RENEW"].includes(requested) ? requested : "REGISTER";
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
const TRANSFER_TYPICAL_DAYS = "5–7 days";
const TRANSFER_EXPECT_WITHIN_DAYS = 7;

function shortDay(ms) {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** One line under the status, plus a longer explanation behind the ⓘ. */
function domainStatusHint(tenant, statusLower) {
  if (statusLower === "transferring") {
    const startedMs = millisOf(tenant.customDomainTransferStartedAt) || millisOf(tenant.customDomainUpdatedAt);
    const when = startedMs
      ? ` Started ${shortDay(startedMs)}, so expect it by about ${shortDay(startedMs + TRANSFER_EXPECT_WITHIN_DAYS * 86400000)}.`
      : "";
    return {
      hint: `Usually takes ${TRANSFER_TYPICAL_DAYS}.${when}`,
      detail:
        `Your old registrar has to release the domain. It usually takes ${TRANSFER_TYPICAL_DAYS} and completes on its own; ` +
        "approving the transfer email from your old registrar can make it faster. Your current website keeps working " +
        "until then, and we’ll email you when it’s live.",
    };
  }
  if (statusLower === "connecting") {
    return {
      hint: "Setting up your secure connection. Usually under an hour.",
      detail: "We’re pointing your domain at your Get Bookking site and issuing its security certificate (the padlock). " +
        "Your free Get Bookking link keeps working meanwhile, and we’ll email you when it’s live.",
    };
  }
  if (statusLower === "active") {
    const expiresMs = millisOf(tenant.customDomainExpiresAt);
    if (!expiresMs) return { hint: "", detail: "" };
    const day = new Date(expiresMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    return tenant.customDomainAutoRenew === false
      ? { hint: `Expires ${day}.`, detail: "Auto-renew is off. Turn it on in the app under Settings → Domain to keep your domain." }
      : { hint: `Renews ${day}.`, detail: "We’ll remind you 7 days before charging your saved card for the next year." }; 
  }
  if (statusLower === "expired" || statusLower === "failed") {
    return { hint: `Questions? Contact ${DOMAIN_SUPPORT_EMAIL}.`, detail: "" };
  }
  return { hint: "", detail: "" };
}

function statusPayload(tenant, tenantId, extras) {
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  const status = (tenant.customDomainStatus || "").toString().trim() || (domain ? "unknown" : "none");
  const source = (tenant.customDomainSource || "").toString().trim() || null;
  const subdomain = (tenant.slug || "").toString().trim().toLowerCase();
  const configured = namecheapConfigured();
  const domainBlocked = isDomainPurchasingBlockedDuringTestFlight(tenant);
  const domainBlockMessage = domainPurchaseBlockReason(tenant) || "";
  const sandbox = isSandboxHost();
  const statusLower = status.toLowerCase();
  const hasDomain = !!domain && statusLower !== "none";
  const renewalLabel = tenant.customDomainRenewalCents ? formatCentsLabel(tenant.customDomainRenewalCents) : "";
  const statusHint = domainStatusHint(tenant, statusLower);

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
    } else if (["transferring", "connecting", "purchasing", "pending", "pending_dns"].includes(statusLower)) {
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
    // The app shows statusMessage as-is, so it carries the hint too; the billing page uses the parts.
    statusMessage: [(tenant.customDomainStatusMessage || "").toString(), statusHint.hint].filter(Boolean).join(" ") || null,
    statusMessageBase: (tenant.customDomainStatusMessage || "").toString() || null,
    statusHint: statusHint.hint || null,
    statusHintDetail: statusHint.detail || null,
    namecheapConfigured: configured,
    providerConfigured: configured,
    canBuyOrTransfer: configured && !domainBlocked,
    domainPurchasingBlockedDuringTestFlight: domainBlocked,
    domainPurchaseBlockMessage: domainBlockMessage,
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
          : `On — renews yearly${renewalLabel ? ` at ${renewalLabel}` : ""} on your saved card`
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
    expiresAt: millisOf(tenant.customDomainExpiresAt) ? new Date(millisOf(tenant.customDomainExpiresAt)).toISOString() : null,
    renewalPriceLabel: renewalLabel || null,
    renewalCardLabel: (tenant.customDomainCardLabel || "").toString() || null,
    buyOnWebUrl: WEB_DOMAIN_PURCHASE_URL,
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

/** Days a domain may stay "connecting" before the Domain screen asks the shop to contact us. */
const CONNECTING_STUCK_DAYS = 3;
/** Days a transfer may stay pending before the same message. */
const TRANSFER_STUCK_DAYS = 10;
const DOMAIN_SUPPORT_EMAIL = "domainsupport@getbookking.com";

function cloudflareConfigured() {
  return !!((cloudflareApiToken.value() || "").trim() && (cloudflareZoneId.value() || "").trim());
}

async function cloudflareRequest(method, path, body) {
  const token = (cloudflareApiToken.value() || "").trim();
  const zone = (cloudflareZoneId.value() || "").trim();
  if (!token || !zone) {
    const err = new Error("Cloudflare is not configured.");
    err.code = "cloudflare-not-configured";
    throw err;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const detail = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ");
    const err = new Error(`Cloudflare ${method} ${path} failed (${res.status}) ${detail}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

/**
 * Registers a hostname with Cloudflare (or finds the existing one). Cloudflare issues its certificate.
 * The bare domain uses text-record checks: it points at us with an ALIAS, which Cloudflare can't follow
 * the way it follows www's CNAME, and its web check can't load until the domain is approved.
 */
async function ensureCustomHostname(hostname, sslMethod = "http") {
  const found = await cloudflareRequest(
    "GET",
    `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`
  );
  if (Array.isArray(found) && found.length) return found[0];
  return cloudflareRequest("POST", "/custom_hostnames", {
    hostname,
    ssl: { method: sslMethod, type: "dv", settings: { min_tls_version: "1.2" } },
  });
}

function customHostnameIsLive(h) {
  return !!(h && h.status === "active" && h.ssl && h.ssl.status === "active");
}

/** Moves a hostname that is still waiting over to text-record checks. Returns the updated hostname. */
async function useTxtChecks(h) {
  if (!h || !h.id || customHostnameIsLive(h) || (h.ssl && h.ssl.method === "txt")) return h;
  return cloudflareRequest("PATCH", `/custom_hostnames/${encodeURIComponent(h.id)}`, {
    ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
  });
}

/** Text records Cloudflare is waiting for, as Namecheap hosts relative to the domain. */
function verificationTxtRecords(domain, h) {
  const relative = (name) => {
    const n = String(name || "").toLowerCase().replace(/\.$/, "");
    if (n === domain) return "@";
    return n.endsWith(`.${domain}`) ? n.slice(0, -(domain.length + 1)) : "";
  };
  const out = [];
  const owner = h && h.ownership_verification;
  if (h && h.status !== "active" && owner && owner.type === "txt" && owner.name && owner.value) {
    out.push({ host: relative(owner.name), type: "TXT", address: owner.value });
  }
  const ssl = (h && h.ssl) || {};
  if (ssl.status !== "active") {
    (ssl.validation_records || []).forEach((r) => {
      if (r.txt_name && r.txt_value) out.push({ host: relative(r.txt_name), type: "TXT", address: r.txt_value });
    });
  }
  return out.filter((r) => r.host);
}

function xmlAttr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag);
  return m ? m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">") : "";
}

/** Current Namecheap DNS records for a domain. */
async function namecheapGetHosts(domain) {
  const { sld, tld } = splitSldTld(domain);
  const raw = await namecheapRequest("namecheap.domains.dns.getHosts", { SLD: sld, TLD: tld });
  if (!namecheapStatusOk(raw)) {
    throw new Error(`getHosts failed: ${namecheapErrorMessage(raw) || "unknown"}`);
  }
  const result = /<DomainDNSGetHostsResult[^>]*>/i.exec(raw);
  const emailType = result ? xmlAttr(result[0], "EmailType") : "";
  const records = (raw.match(/<host\s[^>]*\/?>/gi) || []).map((tag) => ({
    host: xmlAttr(tag, "Name"),
    type: xmlAttr(tag, "Type").toUpperCase(),
    address: xmlAttr(tag, "Address"),
    mxPref: xmlAttr(tag, "MXPref"),
    ttl: xmlAttr(tag, "TTL"),
  }));
  return { records, emailType };
}

const VERIFY_TXT_HOSTS = new Set(["_cf-custom-hostname", "_acme-challenge"]);

/**
 * Adds Cloudflare's text records to the domain's Namecheap DNS, keeping every other record.
 * Old verification values for the same hosts are replaced. Returns how many records were added.
 */
async function addVerificationTxtRecords(domain, txt) {
  if (!txt.length) return 0;
  const key = (r) => `${r.host}|${r.type}|${r.address}`.toLowerCase();
  const wanted = new Set(txt.map(key));
  const { records, emailType } = await namecheapGetHosts(domain);
  const have = new Set(records.map(key));
  const missing = txt.filter((r) => !have.has(key(r)));
  if (!missing.length) return 0;
  if (!records.some((r) => r.host === "@") || !records.some((r) => r.host === "www")) {
    throw new Error("getHosts returned no @ or www record; not rewriting DNS");
  }
  const kept = records.filter((r) => !(r.type === "TXT" && VERIFY_TXT_HOSTS.has(r.host) && !wanted.has(key(r))));
  const all = [...kept, ...missing];
  const { sld, tld } = splitSldTld(domain);
  const params = { SLD: sld, TLD: tld };
  all.forEach((r, i) => {
    const n = i + 1;
    params[`HostName${n}`] = r.host;
    params[`RecordType${n}`] = r.type;
    params[`Address${n}`] = r.address;
    params[`TTL${n}`] = String(r.ttl || 1800);
    if (r.type === "MX") params[`MXPref${n}`] = String(r.mxPref || 10);
  });
  if (emailType) params.EmailType = emailType;
  const raw = await namecheapRequest("namecheap.domains.dns.setHosts", params);
  if (!namecheapStatusOk(raw)) {
    throw new Error(`setHosts failed: ${namecheapErrorMessage(raw) || "unknown"}`);
  }
  return missing.length;
}

/**
 * Live domains: the bare domain's certificate renews every few months with new text records.
 * When Cloudflare is waiting on them, add them so the padlock never lapses.
 */
async function keepApexCertificateRenewing(tenant) {
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  const ids = Array.isArray(tenant.customDomainCloudflareIds) ? tenant.customDomainCloudflareIds : [];
  if (tenant.customDomainStatus !== "active" || !domain || !ids[0] || !cloudflareConfigured()) return 0;
  const h = await cloudflareRequest("GET", `/custom_hostnames/${encodeURIComponent(ids[0])}`);
  if (!h || String(h.hostname || "").toLowerCase() !== domain || customHostnameIsLive(h)) return 0;
  return syncApexVerification(domain, h);
}

/** Gets the bare domain approved: text-record checks at Cloudflare, records added at Namecheap. */
async function syncApexVerification(domain, apexHostname) {
  if (!apexHostname || customHostnameIsLive(apexHostname)) return 0;
  const h = await useTxtChecks(apexHostname);
  const added = await addVerificationTxtRecords(domain, verificationTxtRecords(domain, h));
  if (added) console.log("syncApexVerification", domain, `added ${added} text record(s)`);
  return added;
}

async function removeCustomHostnames(ids) {
  for (const id of ids || []) {
    if (!id) continue;
    try {
      await cloudflareRequest("DELETE", `/custom_hostnames/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status !== 404) console.warn("removeCustomHostnames", id, e.message || e);
    }
  }
}

/**
 * Email and verification records a transferred domain already has, read from public DNS before we
 * switch it to Namecheap DNS. Only names that can be looked up are copied; anything custom the
 * shop added under another name is not discoverable.
 */
const KEPT_CNAME_HOSTS = [
  "autodiscover", "mail", "webmail", "email", "lyncdiscover", "sip",
  "enterpriseregistration", "enterpriseenrollment",
  "selector1._domainkey", "selector2._domainkey", "s1._domainkey", "s2._domainkey",
  "k1._domainkey", "k2._domainkey", "k3._domainkey", "zoho._domainkey",
];
const KEPT_TXT_HOSTS = ["_dmarc", "google._domainkey", "default._domainkey", "zoho._domainkey", "k1._domainkey"];
const KEPT_A_HOSTS = ["mail", "webmail"];

async function quietLookup(fn) {
  try {
    return await fn();
  } catch (_) {
    return null;
  }
}

async function readExistingEmailRecords(domain) {
  const out = [];
  const seen = new Set();
  const add = (rec) => {
    const key = `${rec.host}|${rec.type}|${rec.address}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(rec);
  };
  const mx = await quietLookup(() => dns.resolveMx(domain));
  (mx || []).forEach((r) => add({ host: "@", type: "MX", address: r.exchange, mxPref: r.priority }));
  const apexTxt = await quietLookup(() => dns.resolveTxt(domain));
  (apexTxt || []).forEach((chunks) => add({ host: "@", type: "TXT", address: chunks.join("") }));
  for (const host of KEPT_CNAME_HOSTS) {
    const cname = await quietLookup(() => dns.resolveCname(`${host}.${domain}`));
    if (cname && cname[0]) add({ host, type: "CNAME", address: cname[0] });
  }
  for (const host of KEPT_TXT_HOSTS) {
    const txt = await quietLookup(() => dns.resolveTxt(`${host}.${domain}`));
    (txt || []).forEach((chunks) => add({ host, type: "TXT", address: chunks.join("") }));
  }
  for (const host of KEPT_A_HOSTS) {
    if (out.some((r) => r.host === host)) continue;
    const a = await quietLookup(() => dns.resolve4(`${host}.${domain}`));
    (a || []).forEach((ip) => add({ host, type: "A", address: ip }));
  }
  return out;
}

/**
 * Points the bare domain and www at Get Bookking on Namecheap DNS, plus any kept email records.
 * After a transfer the domain still uses its old DNS host, so it is switched to Namecheap DNS first.
 */
async function pointDomainAtBookking(domain, keptRecords, { switchToNamecheapDns } = {}) {
  const { sld, tld } = splitSldTld(domain);
  const target = (customDomainTarget.value() || "").trim() || "domains.getbookking.com";
  if (switchToNamecheapDns) {
    const raw = await namecheapRequest("namecheap.domains.dns.setDefault", { SLD: sld, TLD: tld });
    if (!namecheapStatusOk(raw)) {
      throw new Error(`setDefault failed: ${namecheapErrorMessage(raw) || "unknown"}`);
    }
  }
  const records = [
    { host: "@", type: "ALIAS", address: target, ttl: 300 },
    { host: "www", type: "CNAME", address: target },
    ...(keptRecords || []).filter((r) => !(r.host === "@" && ["A", "AAAA", "CNAME", "ALIAS"].includes(r.type)) && r.host !== "www"),
  ];
  const params = { SLD: sld, TLD: tld };
  records.forEach((r, i) => {
    const n = i + 1;
    params[`HostName${n}`] = r.host;
    params[`RecordType${n}`] = r.type;
    params[`Address${n}`] = r.address;
    params[`TTL${n}`] = String(r.ttl || 1800);
    if (r.type === "MX") params[`MXPref${n}`] = String(r.mxPref != null ? r.mxPref : 10);
  });
  if (records.some((r) => r.type === "MX")) params.EmailType = "MX";
  const raw = await namecheapRequest("namecheap.domains.dns.setHosts", params);
  if (!namecheapStatusOk(raw)) {
    throw new Error(`setHosts failed: ${namecheapErrorMessage(raw) || "unknown"}`);
  }
  return records.length - 2;
}

/**
 * Points the domain at us and registers it with Cloudflare. Safe to repeat: the background job
 * calls it again until both steps have succeeded. Returns false when Cloudflare isn't set up yet.
 */
async function connectDomainToBookking(tenantRef, tenant) {
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  if (!domain) return false;
  if (!cloudflareConfigured()) {
    console.warn("connectDomainToBookking: Cloudflare not configured; will retry", domain);
    return false;
  }
  const patch = {};
  if (!tenant.customDomainDnsPointedAt) {
    const afterTransfer = (tenant.customDomainSource || "") === "transfer";
    const kept = afterTransfer ? await readExistingEmailRecords(domain) : [];
    const keptCount = await pointDomainAtBookking(domain, kept, { switchToNamecheapDns: afterTransfer });
    patch.customDomainDnsPointedAt = admin.firestore.FieldValue.serverTimestamp();
    patch.customDomainKeptRecordCount = keptCount;
  }
  const apex = await ensureCustomHostname(domain, "txt");
  const www = await ensureCustomHostname(wwwOf(domain));
  try {
    await syncApexVerification(domain, apex);
  } catch (e) {
    console.warn("syncApexVerification (connect)", domain, e.message || e);
  }
  patch.customDomainCloudflareIds = [apex.id, www.id];
  patch.customDomainUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
  await tenantRef.set(patch, { merge: true });
  return true;
}

/** Apple Pay / Google Pay for the domain on the shop's Stripe accounts (see walletDomains.js). */
async function setWalletDomain(tenantId, tenant, domain, enabled) {
  if (!domain || !(stripeSecretKey.value() || "").trim()) return;
  const accounts = await walletDomains.stripeAccountsForShop(getDb(), tenantId, tenant);
  const results = await walletDomains.setWalletDomain(getStripe(), accounts, domain, enabled);
  if (results.length) console.log("setWalletDomain", tenantId, domain, results.join("; "));
}

/** Fields cleared when a shop removes or transfers out its domain. */
function disconnectedDomainPatch() {
  const del = admin.firestore.FieldValue.delete();
  return {
    customDomain: del,
    customDomainWww: del,
    customDomainStatus: "none",
    customDomainSource: del,
    customDomainProvider: del,
    customDomainTransferId: del,
    customDomainStatusMessage: del,
    customDomainTransferOutPreparedAt: del,
    customDomainAutoRenew: del,
    customDomainAutoRenewUpdatedAt: del,
    customDomainCloudflareIds: del,
    customDomainDnsPointedAt: del,
    customDomainKeptRecordCount: del,
    customDomainConnectingSince: del,
    customDomainLiveAt: del,
    customDomainStuckNotedAt: del,
    customDomainExpiresAt: del,
    customDomainTransferStartedAt: del,
    customDomainRenewalCents: del,
    customDomainRenewalWholesaleUsd: del,
    customDomainRenewalQuoteForExpiryMs: del,
    customDomainRenewalFailures: del,
    customDomainRenewalLastAttemptAt: del,
    customDomainEndNoticeAt: del,
    customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function disconnectDomainFromCloudflare(tenant) {
  const ids = Array.isArray(tenant.customDomainCloudflareIds) ? tenant.customDomainCloudflareIds : [];
  if (!ids.length || !cloudflareConfigured()) return;
  await removeCustomHostnames(ids);
}

function millisOf(ts) {
  return ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0;
}

/** True when Namecheap reports the transfer finished; "failed" when it was cancelled or rejected. */
async function transferOutcome(tenant) {
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  const transferId = (tenant.customDomainTransferId || "").toString().trim();
  if (transferId) {
    const raw = await namecheapRequest("namecheap.domains.transfer.getStatus", { TransferID: transferId });
    if (namecheapStatusOk(raw)) {
      const status = (/TransferGetStatusResult[^>]*\sStatus="([^"]*)"/i.exec(raw) || [])[1] || "";
      if (/complet/i.test(status)) return { done: true };
      if (/cancel|fail|reject|timeout|invalid/i.test(status)) return { failed: true, status };
    }
  }
  const info = await namecheapRequest("namecheap.domains.getInfo", { DomainName: domain });
  if (namecheapStatusOk(info) && /^(ok|locked)$/i.test(parseDomainGetInfo(info).domainStatus || "")) {
    return { done: true };
  }
  return {};
}

/**
 * One step forward for a domain that is transferring or connecting. Called by the background job,
 * and right after a purchase so a new domain doesn't wait for the next run.
 */
async function advanceCustomDomain(tenantRef, notifyDomainLive) {
  const snap = await tenantRef.get();
  if (!snap.exists) return "missing";
  const tenant = snap.data() || {};
  const tenantId = tenantRef.id;
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  const status = (tenant.customDomainStatus || "").toString().trim().toLowerCase();
  const slug = (tenant.slug || "").toString().trim().toLowerCase();
  if (!domain) return "no-domain";
  const ageDays = (Date.now() - millisOf(tenant.customDomainConnectingSince || tenant.customDomainUpdatedAt)) / 86400000;

  if (status === "transferring") {
    const outcome = await transferOutcome(tenant);
    if (outcome.failed) {
      await tenantRef.set(
        {
          customDomainStatus: "failed",
          customDomainStatusMessage:
            `The transfer didn’t go through (${outcome.status}). Contact ${DOMAIN_SUPPORT_EMAIL} and we’ll sort it out.`,
          customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      await clearDomainMappings(domain);
      await safeNotify(
        null, tenantId, tenant, "Domain transfer didn't go through",
        `Your old registrar cancelled or rejected the transfer of ${domain} (${outcome.status}). ` +
          `Contact ${DOMAIN_SUPPORT_EMAIL} and we'll sort it out.`,
        `The transfer of ${domain} didn't go through`
      );
      return "transfer-failed";
    }
    if (!outcome.done) {
      if (ageDays > TRANSFER_STUCK_DAYS && !tenant.customDomainStuckNotedAt) {
        await tenantRef.set(
          {
            customDomainStatusMessage: `The transfer is taking longer than usual. Contact ${DOMAIN_SUPPORT_EMAIL} and we’ll check on it.`,
            customDomainStuckNotedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        console.warn("custom domain transfer stuck", tenantId, domain);
      }
      return "transfer-pending";
    }
    await tenantRef.set(
      {
        customDomainStatus: "connecting",
        customDomainConnectingSince: admin.firestore.FieldValue.serverTimestamp(),
        customDomainStuckNotedAt: admin.firestore.FieldValue.delete(),
        customDomainStatusMessage: "Transfer complete. We’re connecting it to your site now.",
        customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await writeDomainMappings({ domain, tenantId, slug, status: "connecting", source: "transfer" });
    await maybeSetNamecheapAutoRenew(domain, false);
    await connectDomainToBookking(tenantRef, { ...tenant, customDomainStatus: "connecting" });
    return "transfer-done";
  }

  if (status !== "connecting") return "skip";

  const ids = Array.isArray(tenant.customDomainCloudflareIds) ? tenant.customDomainCloudflareIds : [];
  if (!tenant.customDomainDnsPointedAt || ids.length < 2) {
    const connected = await connectDomainToBookking(tenantRef, tenant);
    return connected ? "connect-started" : "waiting-for-cloudflare";
  }

  const hosts = await Promise.all(ids.map((id) => cloudflareRequest("GET", `/custom_hostnames/${encodeURIComponent(id)}`)));
  const apexHostname = hosts.find((h) => h && String(h.hostname || "").toLowerCase() === domain);
  if (apexHostname && !customHostnameIsLive(apexHostname)) {
    try {
      await syncApexVerification(domain, apexHostname);
    } catch (e) {
      console.warn("syncApexVerification", tenantId, domain, e.message || e);
    }
  }
  if (hosts.every(customHostnameIsLive)) {
    await tenantRef.set(
      {
        customDomainStatus: "active",
        customDomainStatusMessage: `Connected. ${domain} now opens your site.`,
        customDomainLiveAt: admin.firestore.FieldValue.serverTimestamp(),
        customDomainStuckNotedAt: admin.firestore.FieldValue.delete(),
        customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await writeDomainMappings({ domain, tenantId, slug, status: "active", source: tenant.customDomainSource || null });
    await setWalletDomain(tenantId, tenant, domain, true);
    try {
      await refreshDomainExpiry(tenantRef, domain);
    } catch (e) {
      console.warn("refreshDomainExpiry", tenantId, e.message || e);
    }
    if (typeof notifyDomainLive === "function") {
      try {
        await notifyDomainLive({ tenantId, tenant, domain });
      } catch (e) {
        console.warn("notifyDomainLive", tenantId, e.message || e);
      }
    }
    return "live";
  }
  if (ageDays > CONNECTING_STUCK_DAYS && !tenant.customDomainStuckNotedAt) {
    await tenantRef.set(
      {
        customDomainStatusMessage: `Still connecting. Contact ${DOMAIN_SUPPORT_EMAIL} and we’ll finish it for you.`,
        customDomainStuckNotedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.warn("custom domain stuck connecting", tenantId, domain, hosts.map((h) => `${h.hostname}:${h.status}/${h.ssl && h.ssl.status}`).join(", "));
  }
  return "connecting";
}

const WEB_DOMAIN_PURCHASE_URL = "https://getbookking.com/billing.html#domain";
const WEB_DOMAIN_PURCHASE_MESSAGE =
  "Domains are bought on the web. Open getbookking.com → Account → Billing → Website domain.";
/** Days before expiry: reminder with the amount, then the charge. */
const RENEWAL_REMINDER_DAYS = 37;
const RENEWAL_CHARGE_DAYS = 30;
/** After a declined card, try again every few days until the domain expires. */
const RENEWAL_RETRY_DAYS = 3;

function webReturnOrigin(data) {
  const raw = ((data && data.returnOrigin) || "").toString().trim().replace(/\/+$/, "");
  return /^https:\/\/(www\.)?getbookking\.com$/.test(raw) || /^http:\/\/localhost:\d+$/.test(raw)
    ? raw
    : "https://getbookking.com";
}

function formatCentsLabel(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

/** Platform Stripe customer that holds the card used for domain purchases and renewals. */
async function ensureDomainBillingCustomer(tenantId, tenant, email) {
  const existing = (tenant.domainStripeCustomerId || "").toString().trim();
  if (existing) return existing;
  const customer = await getStripe().customers.create({
    email: email || undefined,
    name: (tenant.businessName || tenant.displayName || "").toString() || undefined,
    metadata: { tenantId, purpose: "custom_domain" },
  });
  await getDb().collection("tenants").doc(tenantId).set({ domainStripeCustomerId: customer.id }, { merge: true });
  return customer.id;
}

function cardLabelOf(paymentMethod) {
  const card = (paymentMethod && paymentMethod.card) || {};
  const brand = (card.brand || "card").toString();
  return `${brand.charAt(0).toUpperCase()}${brand.slice(1)} ending ${card.last4 || "----"}`;
}

/** After a purchase/transfer: the card it was paid with becomes the renewal card. */
async function saveRenewalCardFromPayment(stripe, tenantId, piId, order) {
  const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["payment_method"] });
  const pm = pi.payment_method;
  if (!pm || !pm.id) return;
  await getDb().collection("tenants").doc(tenantId).set(
    {
      customDomainRenewalPaymentMethodId: pm.id,
      customDomainCardLabel: cardLabelOf(pm),
      customDomainRenewalCents: order.renewalCents || null,
    },
    { merge: true }
  );
}

/** Namecheap's expiry date for the domain, saved on the shop. Returns millis or 0. */
async function refreshDomainExpiry(tenantRef, domain) {
  const raw = await namecheapRequest("namecheap.domains.getInfo", { DomainName: domain });
  if (!namecheapStatusOk(raw)) return 0;
  const text = parseDomainGetInfo(raw).expiresAt || "";
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return 0;
  await tenantRef.set({ customDomainExpiresAt: admin.firestore.Timestamp.fromMillis(ms) }, { merge: true });
  return ms;
}

function shopPlanIsCurrent(tenant) {
  if (tenant.complimentaryPaidAccess === true) return true;
  const st = (tenant.subscriptionStatus || "").toString().toLowerCase();
  return ["active", "trialing", "past_due"].includes(st);
}

function formatDay(ms) {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Domain reached its expiry without being renewed: disconnect it; the free subdomain takes over. */
async function expireCustomDomain(tenantRef, tenant, domain, notifyOwner) {
  await disconnectDomainFromCloudflare(tenant);
  await setWalletDomain(tenantRef.id, tenant, domain, false);
  await clearDomainMappings(domain);
  const slug = (tenant.slug || "").toString().trim().toLowerCase();
  const message =
    `${domain} expired and is no longer connected. Your site is back on ${slug}.getbookking.com. ` +
    `Contact ${DOMAIN_SUPPORT_EMAIL} within 30 days if you want it back.`;
  await tenantRef.set(
    {
      customDomainStatus: "expired",
      customDomainStatusMessage: message,
      customDomainCloudflareIds: admin.firestore.FieldValue.delete(),
      customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await safeNotify(notifyOwner, tenantRef.id, tenant, "Your domain expired", message, `${domain} has expired`);
}

/** Set by registerCustomDomainFunctions: app notification + activity notice + email to the owner. */
let ownerNotifier = null;

async function safeNotify(notifyOwner, tenantId, tenant, title, body, emailSubject) {
  const fn = typeof notifyOwner === "function" ? notifyOwner : ownerNotifier;
  if (typeof fn !== "function") return;
  try {
    await fn({ tenantId, tenant, title, body, emailSubject: emailSubject || title });
  } catch (e) {
    console.warn("domain notifyOwner", tenantId, e.message || e);
  }
}

async function ownerEmailOf(tenant) {
  const uid = (tenant.ownerUid || "").toString().trim();
  if (!uid) return "";
  const snap = await getDb().collection("users").doc(uid).get();
  return snap.exists ? ((snap.data() || {}).email || "").toString().trim() : "";
}

/**
 * One daily step for a connected domain's yearly renewal:
 * 37 days before expiry — reminder with the exact amount; 30 days before — charge the saved card,
 * then renew at Namecheap; declined cards retry every 3 days; at expiry — disconnect.
 * No plan or auto-renew off — one notice 30 days before, then it expires.
 */
async function processDomainRenewal(tenantRef, notifyOwner, nowMs) {
  const snap = await tenantRef.get();
  const tenant = snap.data() || {};
  const domain = (tenant.customDomain || "").toString().trim().toLowerCase();
  const status = (tenant.customDomainStatus || "").toString().toLowerCase();
  if (!domain || !["active", "connecting"].includes(status)) return "skip";
  const now = nowMs || Date.now();
  let expiresMs = millisOf(tenant.customDomainExpiresAt);
  if (!expiresMs) expiresMs = await refreshDomainExpiry(tenantRef, domain);
  if (!expiresMs) return "no-expiry";
  const daysLeft = (expiresMs - now) / 86400000;
  const expiryDay = formatDay(expiresMs);

  if (daysLeft <= 0) {
    // Renewed elsewhere or late? Re-read Namecheap before disconnecting.
    const fresh = await refreshDomainExpiry(tenantRef, domain);
    if (fresh > now) return "renewed-elsewhere";
    await expireCustomDomain(tenantRef, tenant, domain, notifyOwner);
    return "expired";
  }

  const wantsRenewal = tenant.customDomainAutoRenew !== false && shopPlanIsCurrent(tenant);
  if (!wantsRenewal) {
    if (daysLeft <= RENEWAL_CHARGE_DAYS && millisOf(tenant.customDomainEndNoticeAt) < expiresMs - 60 * 86400000) {
      const body = shopPlanIsCurrent(tenant)
        ? `Auto-renew is off, so ${domain} expires on ${expiryDay}. To keep it, turn auto-renew on in Settings → Domain.`
        : `Your Get Bookking plan has ended, so ${domain} won't renew and expires on ${expiryDay}. ` +
          "To keep it, restart your plan or transfer the domain out in Settings → Domain.";
      await tenantRef.set({ customDomainEndNoticeAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      await safeNotify(notifyOwner, tenantRef.id, tenant, "Your domain won't renew", body, `${domain} expires on ${expiryDay}`);
      return "end-notice";
    }
    return "not-renewing";
  }

  if (daysLeft > RENEWAL_REMINDER_DAYS) return "not-due";
  const chargeDayMs = expiresMs - RENEWAL_CHARGE_DAYS * 86400000;
  const quoteForThisYear = Number(tenant.customDomainRenewalQuoteForExpiryMs || 0) === expiresMs;

  if (!quoteForThisYear) {
    const price = await resolveCustomerDomainPrice(domain, "RENEW");
    const previous = Number(tenant.customDomainRenewalCents || 0);
    await tenantRef.set(
      {
        customDomainRenewalCents: price.totalCents,
        customDomainRenewalWholesaleUsd: price.wholesale,
        customDomainRenewalQuoteForExpiryMs: expiresMs,
        customDomainRenewalFailures: 0,
      },
      { merge: true }
    );
    const changed = previous && previous !== price.totalCents ? ` (was ${formatCentsLabel(previous)}; the registry price changed)` : "";
    const cardNote = tenant.customDomainRenewalPaymentMethodId
      ? `your ${tenant.customDomainCardLabel || "saved card"}`
      : "a card — add one on the web: Billing → Website domain";
    await safeNotify(
      notifyOwner, tenantRef.id, tenant, "Domain renewal coming up",
      `${domain} renews on ${formatDay(Math.max(chargeDayMs, now))} for ${formatCentsLabel(price.totalCents)}${changed}, charged to ${cardNote}. Turn off auto-renew in Settings → Domain if you don't want to keep it.`,
      `${domain} renews on ${formatDay(Math.max(chargeDayMs, now))} for ${formatCentsLabel(price.totalCents)}`
    );
    return "reminded";
  }

  if (now < chargeDayMs) return "waiting-to-charge";
  const lastAttempt = millisOf(tenant.customDomainRenewalLastAttemptAt);
  if (lastAttempt && now - lastAttempt < RENEWAL_RETRY_DAYS * 86400000) return "retry-later";

  const customerId = (tenant.domainStripeCustomerId || "").toString().trim();
  const paymentMethodId = (tenant.customDomainRenewalPaymentMethodId || "").toString().trim();
  const amount = Number(tenant.customDomainRenewalCents || 0);
  if (!customerId || !paymentMethodId || amount < 50) {
    await tenantRef.set({ customDomainRenewalLastAttemptAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await safeNotify(
      notifyOwner, tenantRef.id, tenant, "Add a card to keep your domain",
      `${domain} expires on ${expiryDay}. Add a card on the web (Billing → Website domain) so we can renew it.`,
      `Action needed: add a card to keep ${domain}`
    );
    return "no-card";
  }

  const stripe = getStripe();
  const attempt = Number(tenant.customDomainRenewalFailures || 0) + 1;
  let pi;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethodId,
        payment_method_types: ["card"],
        off_session: true,
        confirm: true,
        receipt_email: (await ownerEmailOf(tenant)) || undefined,
        description: `Domain renewal: ${domain}`,
        metadata: { paymentKind: "domain_renewal", tenantId: tenantRef.id, domain, expiresMs: String(expiresMs) },
      },
      { idempotencyKey: `domain-renewal-${tenantRef.id}-${expiresMs}-${attempt}` }
    );
  } catch (e) {
    pi = null;
    console.warn("domain renewal charge declined", tenantRef.id, domain, e.message || e);
  }
  if (!pi || pi.status !== "succeeded") {
    await tenantRef.set(
      {
        customDomainRenewalFailures: attempt,
        customDomainRenewalLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await safeNotify(
      notifyOwner, tenantRef.id, tenant, "Domain renewal payment failed",
      `We couldn't charge ${formatCentsLabel(amount)} to your ${tenant.customDomainCardLabel || "saved card"} to renew ${domain}. ` +
        `Update your card at getbookking.com → Billing → Website domain before ${expiryDay} to keep your domain. We'll try again in ${RENEWAL_RETRY_DAYS} days.`,
      `Action needed: we couldn't renew ${domain}`
    );
    return "charge-failed";
  }

  const raw = await namecheapRequest("namecheap.domains.renew", { DomainName: domain, Years: "1" });
  if (!namecheapStatusOk(raw)) {
    await stripe.refunds.create({ payment_intent: pi.id }, { idempotencyKey: `domain-renewal-refund-${pi.id}` });
    await tenantRef.set({ customDomainRenewalLastAttemptAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    console.error("domain renewal at Namecheap failed after charging (refunded)", tenantRef.id, domain, namecheapErrorMessage(raw));
    return "renew-failed-refunded";
  }
  const newExpiry = (await refreshDomainExpiry(tenantRef, domain)) || expiresMs + 365 * 86400000;
  await tenantRef.set(
    {
      customDomainLastRenewedAt: admin.firestore.FieldValue.serverTimestamp(),
      customDomainRenewalFailures: 0,
      customDomainRenewalLastAttemptAt: admin.firestore.FieldValue.delete(),
      customDomainRenewalLastPaymentIntentId: pi.id,
    },
    { merge: true }
  );
  await safeNotify(
    notifyOwner, tenantRef.id, tenant, "Domain renewed",
    `We charged ${formatCentsLabel(amount)} to your ${tenant.customDomainCardLabel || "saved card"} on ${formatDay(now)}. ${domain} is renewed until ${formatDay(newExpiry)}.`,
    `${domain} renewed`
  );
  return "renewed";
}

/** "Purchased" / "transfer started" notice; includes the charge details so it doubles as a receipt. */
async function notifyDomainPaid(tenantId, order, domain) {
  const fresh = (await getDb().collection("tenants").doc(tenantId).get()).data() || {};
  const card = fresh.customDomainCardLabel || "your card";
  const paid = formatCentsLabel(order.amountCents || 0);
  const today = formatDay(Date.now());
  const renewal = order.renewalCents ? formatCentsLabel(order.renewalCents) : "";
  const renewNote = order.autoRenew === false
    ? "Auto-renew is off, so it expires after one year unless you turn it on in Settings → Domain."
    : `It renews yearly at ${renewal || "the current price"} on this card until you turn off auto-renew in Settings → Domain. ` +
      "Renewal is handled by Get Bookking, so you can ignore renewal reminders from Namecheap.";
  const confirmNote =
    "One thing to do: the domain registrar (Namecheap) will email you asking to confirm your email address. " +
    "Please click the link in that email, or the domain can be paused.";
  if (order.kind === "transfer") {
    await safeNotify(
      null, tenantId, fresh, "Domain transfer started",
      `Charged ${paid} to ${card} on ${today} for: domain transfer of ${domain} (includes 1 year). ` +
        "Your current registrar may email you to approve the transfer; approving makes it faster. " +
        "Once connected, your domain will open your Get Bookking site instead of your old website. " +
        `Remember to cancel your old website plan. ${renewNote} ${confirmNote}`,
      `Transfer of ${domain} started`
    );
    return;
  }
  await safeNotify(
    null, tenantId, fresh, "Domain purchased",
    `Charged ${paid} to ${card} on ${today} for: domain registration of ${domain} (1 year). ` +
      `We're connecting it to your Get Bookking site now — usually under an hour. ${renewNote} ${confirmNote}`,
    `Your domain ${domain} is set up`
  );
}

/** A failure where Namecheap clearly did not register or start the transfer, so the payment is refunded. */
function refundableDomainError(message) {
  const err = new Error(message);
  err.refundable = true;
  return err;
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
    throw refundableDomainError(`${domain} was taken before we could register it.`);
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
    throw refundableDomainError(
      `${domain} couldn't be registered (${namecheapErrorMessage(createRaw) || "registrar error"}).`
    );
  }
  const created = parseDomainCreateSuccess(createRaw);
  if (!created.registered) {
    throw refundableDomainError(`${domain} couldn't be registered.`);
  }

  const wantAutoRenew = autoRenew !== false;
  await maybeSetNamecheapAutoRenew(domain, false);
  // "active" is set only once the domain serves the site over HTTPS.
  const status = "connecting";
  const statusMessage = isSandboxHost()
    ? "Registered in Namecheap sandbox (test). Sandbox domains can’t load a website."
    : "Domain registered. We’re connecting it to your site — this usually takes under an hour.";

  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .set(
      {
        customDomain: domain,
        customDomainWww: wwwOf(domain),
        customDomainStatus: status,
        customDomainConnectingSince: admin.firestore.FieldValue.serverTimestamp(),
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
    orderId: created.orderId,
    chargedAmount: created.chargedAmount,
    customerPaidUsd: payment && payment.customerPaidUsd,
    message: isSandboxHost()
      ? `${domain} is yours in sandbox (test).`
      : `${domain} purchased. We’re connecting it now — this usually takes under an hour. Your free link keeps working meanwhile.`,
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
    throw refundableDomainError(
      `The transfer of ${domain} couldn't start (${namecheapErrorMessage(transferRaw) || "registrar error"}). ` +
        "Check the authorization code and that the domain is unlocked at your current registrar."
    );
  }

  const transferIdMatch = /TransferID="(\d+)"/i.exec(transferRaw);
  const transferId = transferIdMatch ? transferIdMatch[1] : null;

  const wantAutoRenew = autoRenew !== false;
  // Namecheap never renews on its own (the transfer may still be pending; the daily job retries).
  await maybeSetNamecheapAutoRenew(domain, false);

  await getDb()
    .collection("tenants")
    .doc(tenantId)
    .set(
      {
        customDomain: domain,
        customDomainWww: wwwOf(domain),
        customDomainStatus: "transferring",
        customDomainTransferStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        customDomainSource: "transfer",
        customDomainProvider: "namecheap",
        customDomainTransferId: transferId || null,
        customDomainStatusMessage:
          "Transfer started. Approve any email from your old registrar. Once connected, your domain will open your Get Bookking site instead of your old website. Remember to cancel your old website plan so you’re not still paying for it.",
        customDomainStripePaymentIntentId: (payment && payment.paymentIntentId) || null,
        customDomainCustomerPaidUsd: (payment && payment.customerPaidUsd) || null,
        customDomainWholesaleUsd: (payment && payment.wholesaleUsd) || null,
        customDomainAutoRenew: wantAutoRenew,
        customDomainUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
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

  return {
    ok: true,
    domain,
    status: "transferring",
    transferId,
    customerPaidUsd: payment && payment.customerPaidUsd,
    message:
      "Transfer started. Approve any email from your old registrar; we’ll connect the domain when the transfer finishes. Once connected, your domain will open your Get Bookking site instead of your old website. Remember to cancel your old website plan so you’re not still paying for it.",
    publicUrl: `https://${domain}`,
  };
}

async function createPendingDomainPayment({
  uid,
  tenantId,
  customerId,
  receiptEmail,
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
  renewalCents,
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
    customer: customerId,
    receipt_email: receiptEmail || undefined,
    // Card only; saved so the yearly renewal can be charged while the shop isn't on the page.
    payment_method_types: ["card"],
    setup_future_usage: "off_session",
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
      renewalCents: renewalCents || null,
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
    renewalCents: renewalCents || null,
    renewalPriceLabel: renewalCents ? formatCentsLabel(renewalCents) : null,
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
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(piId);
  if (pi.status !== "succeeded") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Payment has not completed yet."
    );
  }

  // The app and the Stripe webhook both call this right after payment; only one may register.
  const claim = await getDb().runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    const current = snap.data() || {};
    const startedMs = millisOf(current.processingAt);
    if (current.status === "fulfilled") return { done: "fulfilled", order: current };
    if (current.status === "refunded") return { done: "refunded", order: current };
    if (current.status === "needs_review") return { done: "needs_review", order: current };
    if (current.status === "processing" && Date.now() - startedMs < 10 * 60 * 1000) {
      return { done: "processing", order: current };
    }
    tx.set(orderRef, { status: "processing", processingAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { order: current };
  });
  const order = claim.order;
  if (claim.done === "fulfilled") {
    return { ok: true, alreadyFulfilled: true, domain: order.domain, status: "connecting" };
  }
  if (claim.done === "processing") {
    return {
      ok: true,
      processing: true,
      domain: order.domain,
      status: "connecting",
      message: "Payment received. We're registering your domain now.",
    };
  }
  if (claim.done === "refunded") {
    throw new functions.https.HttpsError("failed-precondition", order.failureMessage || "This purchase was refunded.");
  }
  if (claim.done === "needs_review") {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `We're looking into this purchase. Contact ${DOMAIN_SUPPORT_EMAIL} if you have questions.`
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
    ["active", "connecting", "transferring"].includes(existingStatus) &&
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
  try {
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
  } catch (err) {
    if (err && err.refundable) {
      await stripe.refunds.create({ payment_intent: piId }, { idempotencyKey: `domain-refund-${piId}` });
      const failureMessage = `${err.message} Your payment has been refunded.`;
      await orderRef.set(
        {
          status: "refunded",
          failureMessage,
          authCode: admin.firestore.FieldValue.delete(),
          refundedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      console.warn("domain purchase refunded", piId, domain, err.message);
      throw new functions.https.HttpsError("failed-precondition", failureMessage);
    }
    // Unclear outcome (e.g. registered but saving failed): keep the money, flag for a person to check.
    await orderRef.set(
      {
        status: "needs_review",
        failureMessage: (err && err.message) || String(err),
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    console.error("domain purchase needs review", piId, domain, err);
    throw new functions.https.HttpsError(
      "internal",
      `Payment received, but we couldn't finish setting up ${domain}. We'll sort it out — contact ${DOMAIN_SUPPORT_EMAIL}.`
    );
  }

  await orderRef.set(
    {
      status: "fulfilled",
      authCode: admin.firestore.FieldValue.delete(),
      fulfilledAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  try {
    await saveRenewalCardFromPayment(stripe, tenantId, piId, order);
  } catch (e) {
    console.warn("saveRenewalCardFromPayment", tenantId, piId, e.message || e);
  }
  await notifyDomainPaid(tenantId, order, domain);
  return result;
}

/**
 * @param {object} [options]
 * @param {Function} [options.notifyDomainLive] ({ tenantId, tenant, domain }) — tells the owner the domain is live.
 */
function registerCustomDomainFunctions(exportsObj, options) {
  const notifyOwner = options && options.notifyOwner;
  ownerNotifier = notifyOwner || null;
  const notifyDomainLive = ({ tenantId, tenant, domain }) => {
    const slug = (tenant.slug || "").toString().trim().toLowerCase();
    return safeNotify(
      notifyOwner, tenantId, tenant, "Your domain is live",
      `${domain} now opens your Get Bookking site.` +
        (slug ? ` Your old link (${slug}.getbookking.com) automatically forwards there.` : ""),
      `${domain} is live`
    );
  };

  /** Daily: yearly renewals — reminder 37 days out, charge 30 days out, expire if unpaid. */
  exportsObj.renewCustomDomains = functions
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey, cloudflareApiToken] })
    .pubsub.schedule("every 24 hours")
    .onRun(async () => {
      const snap = await getDb()
        .collection("tenants")
        .where("customDomainStatus", "in", ["active", "connecting"])
        .get();
      const outcomes = {};
      for (const doc of snap.docs) {
        let outcome;
        try {
          outcome = await processDomainRenewal(doc.ref, notifyOwner);
        } catch (e) {
          outcome = "error";
          console.error("renewCustomDomains", doc.id, e.message || e);
        }
        outcomes[outcome] = (outcomes[outcome] || 0) + 1;
        try {
          await keepApexCertificateRenewing(doc.data() || {});
        } catch (e) {
          console.warn("keepApexCertificateRenewing", doc.id, e.message || e);
        }
      }
      console.log("renewCustomDomains", JSON.stringify(outcomes));
      return null;
    });

  /** Web billing: replace the card used for domain renewals (Stripe card form, setup mode). */
  exportsObj.createDomainCardSetup = functions
    .runWith({ secrets: [stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const tenantId = await resolveUidTenant(context.auth.uid);
      const tenant = (await assertTenantOwner(context.auth.uid, tenantId)).data() || {};
      const customerId = await ensureDomainBillingCustomer(tenantId, tenant, context.auth.token.email);
      const session = await getStripe().checkout.sessions.create({
        mode: "setup",
        ui_mode: "embedded",
        customer: customerId,
        payment_method_types: ["card"],
        metadata: { tenantId, purpose: "custom_domain" },
        return_url: `${webReturnOrigin(data)}/billing.html?domain_card=success&session_id={CHECKOUT_SESSION_ID}#domain`,
      });
      return {
        clientSecret: session.client_secret,
        publishableKey: (stripePublishableKeyParam.value() || "").trim() || null,
      };
    });

  exportsObj.getDomainBillingHistory = functions
    .runWith({ secrets: [stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const tenantId = await resolveUidTenant(context.auth.uid);
      const tenant = (await assertTenantOwner(context.auth.uid, tenantId)).data() || {};
      const customerId = (tenant.domainStripeCustomerId || "").toString().trim();
      if (!customerId) return { charges: [] };
      const list = await getStripe().charges.list({ customer: customerId, limit: 24 });
      return {
        charges: (list.data || [])
          .filter((c) => c.status === "succeeded" && /^Domain /.test(c.description || ""))
          .map((c) => ({
            id: c.id,
            description: c.description,
            amountCents: c.amount,
            refundedCents: c.amount_refunded || 0,
            created: c.created * 1000,
            receiptUrl: c.receipt_url || null,
          })),
      };
    });

  exportsObj.completeDomainCardSetup = functions
    .runWith({ secrets: [stripeSecretKey] })
    .https.onCall(async (data, context) => {
      if (!context.auth || !context.auth.uid) {
        throw new functions.https.HttpsError("unauthenticated", "Sign in required");
      }
      const tenantId = await resolveUidTenant(context.auth.uid);
      const tenant = (await assertTenantOwner(context.auth.uid, tenantId)).data() || {};
      const customerId = (tenant.domainStripeCustomerId || "").toString().trim();
      const sessionId = ((data && data.sessionId) || "").toString().trim();
      if (!customerId || !sessionId) {
        throw new functions.https.HttpsError("invalid-argument", "Card setup was not started.");
      }
      const session = await getStripe().checkout.sessions.retrieve(sessionId, {
        expand: ["setup_intent.payment_method"],
      });
      const sessionCustomer = typeof session.customer === "string" ? session.customer : session.customer && session.customer.id;
      const pm = session.setup_intent && session.setup_intent.payment_method;
      if (session.mode !== "setup" || sessionCustomer !== customerId || session.status !== "complete" || !pm || !pm.id) {
        throw new functions.https.HttpsError("failed-precondition", "The card was not saved. Try again.");
      }
      const cardLabel = cardLabelOf(pm);
      await getDb().collection("tenants").doc(tenantId).set(
        {
          customDomainRenewalPaymentMethodId: pm.id,
          customDomainCardLabel: cardLabel,
          // A new card gets a fresh try straight away.
          customDomainRenewalLastAttemptAt: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
      return { ok: true, cardLabel };
    });

  /** Every 15 minutes: finish transfers and mark domains live once Cloudflare's certificate is active. */
  exportsObj.advanceCustomDomains = functions
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey, cloudflareApiToken] })
    .pubsub.schedule("every 15 minutes")
    .onRun(async () => {
      const snap = await getDb()
        .collection("tenants")
        .where("customDomainStatus", "in", ["transferring", "connecting"])
        .get();
      if (snap.empty) return null;
      const outcomes = {};
      for (const doc of snap.docs) {
        let outcome;
        try {
          outcome = await advanceCustomDomain(doc.ref, notifyDomainLive);
        } catch (e) {
          outcome = "error";
          console.error("advanceCustomDomains", doc.id, e.message || e);
        }
        outcomes[outcome] = (outcomes[outcome] || 0) + 1;
      }
      console.log("advanceCustomDomains", JSON.stringify(outcomes));
      return null;
    });

  exportsObj.getCustomDomainStatus = functions
    .runWith({ secrets: [namecheapApiKey] })
    .https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required");
    }
    const tenantId = await resolveUidTenant(context.auth.uid);
    const tenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
    const tenant = tenantDoc.data() || {};

    let extras = {};
    const domainName = (tenant.customDomain || "").toString().trim().toLowerCase();
    if (
      domainName &&
      ["active", "connecting", "transferring"].includes((tenant.customDomainStatus || "").toString().toLowerCase())
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
      const searchTenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
      const searchTenant = searchTenantDoc.data() || {};

      const query = normalizeSearchQuery(data && data.query);
      if (!query || query.length < 1) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a name like mystudio or mystudio.com"
        );
      }

      const markup = readMarkupConfig();
      const domainBlocked = isDomainPurchasingBlockedDuringTestFlight(searchTenant);
      const domainBlockMessage = domainPurchaseBlockReason(searchTenant) || "";
      if (!namecheapConfigured() || !(namecheapApiKey.value() || "").trim()) {
        return {
          ok: true,
          query,
          results: [],
          providerConfigured: false,
          canBuyOrTransfer: false,
          domainPurchasingBlockedDuringTestFlight: domainBlocked,
          domainPurchaseBlockMessage: domainBlockMessage,
          markup,
          message:
            "Domain search unlocks once Namecheap API is connected. Your free subdomain still works.",
        };
      }
      if (domainBlocked) {
        return {
          ok: true,
          query,
          results: [],
          providerConfigured: true,
          canBuyOrTransfer: false,
          domainPurchasingBlockedDuringTestFlight: true,
          domainPurchaseBlockMessage: domainBlockMessage,
          markup,
          message: domainBlockMessage,
        };
      }

      const domainList = buildSearchDomainList(query);
      if (!domainList.length) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Enter a valid name (letters, numbers, hyphens)."
        );
      }

      const [checkRaw, registerPricingAttempt, transferPricingAttempt, renewPricingAttempt] = await Promise.all([
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
        namecheapRequest("namecheap.users.getPricing", {
          ProductType: "DOMAIN",
          ActionName: "RENEW",
        }).catch((e) => {
          console.warn("getPricing RENEW failed", e.message || e);
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
      const renewPricingRaw = namecheapStatusOk(renewPricingAttempt) ? renewPricingAttempt : "";

      const checks = parseAllDomainChecks(checkRaw);
      const results = domainList.map((domain) => {
        const { tld } = splitSldTld(domain);
        const check = checks[domain] || {};
        // Premium names cost far more than the normal price; they aren't sold here yet.
        const available =
          check.premium === true ? false : typeof check.available === "boolean" ? check.available : null;
        const wholesaleRegister =
          parseTldPriceFromPricingXml(registerPricingRaw, tld, "REGISTER") ??
          FALLBACK_REGISTER_USD[tld] ??
          null;
        const wholesaleTransfer =
          parseTldPriceFromPricingXml(transferPricingRaw, tld, "TRANSFER") ??
          FALLBACK_TRANSFER_USD[tld] ??
          null;
        const wholesaleRenew =
          parseTldPriceFromPricingXml(renewPricingRaw, tld, "RENEW") ?? wholesaleRegister;
        const customerRenew = applyCustomerMarkup(wholesaleRenew);
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
          renewPriceLabel: formatMoneyLabel(customerRenew),
          transferPriceLabel: formatMoneyLabel(customerTransfer),
          statusLabel:
            check.premium === true
              ? "Premium name — not offered"
              : available === true
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
        domainPurchasingBlockedDuringTestFlight: false,
        domainPurchaseBlockMessage: "",
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
      const domainBlock = domainPurchaseBlockReason(tenant);
      if (domainBlock) {
        throw new functions.https.HttpsError("failed-precondition", domainBlock);
      }
      if ((data && data.source) !== "web") {
        throw new functions.https.HttpsError("failed-precondition", WEB_DOMAIN_PURCHASE_MESSAGE);
      }
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
      if (
        existing &&
        existing !== domain &&
        ["active", "connecting", "transferring"].includes((tenant.customDomainStatus || "").toString().toLowerCase())
      ) {
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
      if ((parseAllDomainChecks(checkRaw)[domain] || {}).premium === true) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          `${domain} is a premium name, which we don't offer yet. Try a different name.`
        );
      }

      const pricing = await resolveCustomerDomainPrice(domain, "REGISTER");
      const renewal = await resolveCustomerDomainPrice(domain, "RENEW");
      const autoRenew = parseAutoRenewFlag(data && data.autoRenew);
      const customerId = await ensureDomainBillingCustomer(tenantId, tenant, context.auth.token.email);
      const payment = await createPendingDomainPayment({
        uid,
        tenantId,
        customerId,
        receiptEmail: context.auth.token.email || "",
        renewalCents: renewal.totalCents,
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
    .runWith({ secrets: [namecheapApiKey, stripeSecretKey, cloudflareApiToken] })
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
      const result = await fulfillDomainPaymentIntent(paymentIntentId, { uid: context.auth.uid });
      try {
        await advanceCustomDomain(getDb().collection("tenants").doc(order.tenantId), notifyDomainLive);
      } catch (e) {
        console.warn("connect after purchase (background job will retry)", order.tenantId, e.message || e);
      }
      return result;
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
      const domainBlock = domainPurchaseBlockReason(tenant);
      if (domainBlock) {
        throw new functions.https.HttpsError("failed-precondition", domainBlock);
      }
      if ((data && data.source) !== "web") {
        throw new functions.https.HttpsError("failed-precondition", WEB_DOMAIN_PURCHASE_MESSAGE);
      }
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
      if (
        existing &&
        existing !== domain &&
        ["active", "connecting", "transferring"].includes((tenant.customDomainStatus || "").toString().toLowerCase())
      ) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Remove your current connected domain before transferring another."
        );
      }

      const pricing = await resolveCustomerDomainPrice(domain, "TRANSFER");
      const renewal = await resolveCustomerDomainPrice(domain, "RENEW");
      const autoRenew = parseAutoRenewFlag(data && data.autoRenew);
      const customerId = await ensureDomainBillingCustomer(tenantId, tenant, context.auth.token.email);
      const payment = await createPendingDomainPayment({
        uid,
        tenantId,
        customerId,
        receiptEmail: context.auth.token.email || "",
        renewalCents: renewal.totalCents,
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

  exportsObj.removeCustomDomain = functions
    .runWith({ secrets: [cloudflareApiToken, stripeSecretKey] })
    .https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required");
    }
    const tenantId = await resolveUidTenant(context.auth.uid);
    const tenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
    const tenant = tenantDoc.data() || {};
    const domain = (tenant.customDomain || "").toString().trim().toLowerCase();

    await disconnectDomainFromCloudflare(tenant);
    await setWalletDomain(tenantId, tenant, domain, false);
    await getDb()
      .collection("tenants")
      .doc(tenantId)
      .set(disconnectedDomainPatch(), { merge: true });

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
      if (!["active", "connecting"].includes(status)) {
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
      if (!domain || !["active", "connecting", "transferring"].includes(status)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Connect a domain before changing auto-renew."
        );
      }
      const autoRenew = parseAutoRenewFlag(data && data.autoRenew);
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
        message: autoRenew
          ? "Auto-renew is on. We’ll remind you 7 days before charging your saved card for the next year."
          : "Auto-renew is off. Your domain will expire at the end of its year unless you turn it back on.",
      };
    });

  /** After the domain has left Namecheap / Bookking, clear tenant custom domain. */
  exportsObj.confirmDomainTransferOut = functions
    .runWith({ secrets: [cloudflareApiToken, stripeSecretKey] })
    .https.onCall(async (data, context) => {
    if (!context.auth || !context.auth.uid) {
      throw new functions.https.HttpsError("unauthenticated", "Sign in required");
    }
    const tenantId = await resolveUidTenant(context.auth.uid);
    const tenantDoc = await assertTenantOwner(context.auth.uid, tenantId);
    const tenant = tenantDoc.data() || {};
    const domain = (tenant.customDomain || "").toString().trim().toLowerCase();

    await disconnectDomainFromCloudflare(tenant);
    await setWalletDomain(tenantId, tenant, domain, false);
    await getDb()
      .collection("tenants")
      .doc(tenantId)
      .set(disconnectedDomainPatch(), { merge: true });

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
   * GET ?slug=bleustattoos → { slug, domain } when that shop has a connected domain (subdomain forwarding).
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
    const slugQuery = ((req.query && req.query.slug) || "").toString().trim().toLowerCase();
    if (slugQuery) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slugQuery)) {
        res.status(400).json({ error: "invalid slug" });
        return;
      }
      const bySlug = await getDb()
        .collection("domainMappings")
        .where("slug", "==", slugQuery)
        .where("status", "==", "active")
        .get();
      const apex = bySlug.docs.map((d) => d.id).find((h) => !h.startsWith("www."));
      if (!apex) {
        res.status(404).json({ ok: false, slug: slugQuery, domain: null });
        return;
      }
      res.status(200).json({ ok: true, slug: slugQuery, domain: apex });
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
      // While connecting, the gateway sends visitors to the shop's free address instead of an error page.
      const fallbackSlug = status === "connecting" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : null;
      res.status(404).json({ ok: false, host, slug: null, status: status || null, fallbackSlug });
      return;
    }
    // Public resolver: slug + status only (no tenantId enumeration).
    res.status(200).json({ ok: true, host, slug, status });
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
