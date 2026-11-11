/**
 * Get Bookking MCP server (phase 1: read-only).
 *
 * Lets a shop owner connect an AI assistant (Claude, etc.) to their shop with a personal key.
 * Speaks MCP over Streamable HTTP (JSON-RPC 2.0, JSON responses; no server-sent events needed).
 *
 * Connect with either:
 *   - the personal connector URL:  https://<region>-<project>.cloudfunctions.net/mcpServer/k/<key>
 *   - or the base URL plus header:  Authorization: Bearer <key>
 *
 * Keys are created in the web app (Settings → AI assistant). Only a SHA-256 hash is stored
 * (collection mcpKeys/{hash}). While in early access, only owners on the allow-list can create keys:
 * MCP_ALLOWED_EMAILS (comma-separated) in functions/.env, or tenants/{id}.mcpEnabled == true.
 *
 * Every tool only reads the key owner's own shop, and every call is logged to tenants/{id}/mcpLog.
 */
const functions = require("firebase-functions");
const { defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const oauth = require("./mcpOAuth");

const mcpAllowedEmails = defineString("MCP_ALLOWED_EMAILS", { default: "" });

const SERVER_INFO = { name: "get-bookking", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const PER_MINUTE = 60;
const PER_DAY = 3000;
const KEY_PREFIX = "gbk_";

let dbOverride = null; // tests only
function db() {
  return dbOverride || admin.firestore();
}

function hashKey(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function newRawKey() {
  return KEY_PREFIX + crypto.randomBytes(24).toString("base64url");
}

function connectorBaseUrl() {
  const project = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "test-app-96812";
  return `https://us-central1-${project}.cloudfunctions.net/mcpServer`;
}

function allowListed(email) {
  const list = (mcpAllowedEmails.value() || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!email && list.includes(String(email).trim().toLowerCase());
}

/* ── Small helpers ── */

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v._seconds === "number") return new Date(v._seconds * 1000);
  if (typeof v.seconds === "number") return new Date(v.seconds * 1000);
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function tzOf(tenant) {
  const tz = (tenant && (tenant.timeZone || tenant.timezone)) || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch (e) {
    return "America/New_York";
  }
}

/** YYYY-MM-DD for a date in the shop's time zone. */
function dayKey(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function whenLabel(date, tz) {
  return date.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Same start-time rules as the web app calendar (requestedStartTime, then scheduledDate + minutes). */
function appointmentStart(doc) {
  const requested = toDate(doc.requestedStartTime);
  if (requested) return requested;
  const iso = String(doc.scheduledDate || "").trim();
  let startMin = doc.scheduledStartMin;
  if (typeof startMin === "string") startMin = parseInt(startMin, 10);
  if (iso.length >= 10 && typeof startMin === "number" && !isNaN(startMin)) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, Math.floor(startMin / 60), startMin % 60);
  }
  return null;
}

const BOOKED = new Set(["confirmed", "pending_deposit", "pending_payment", "completed"]);
const REQUEST = new Set(["new", "pending", "pending_consultation"]);

function money(cents) {
  return "$" + (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

function textResult(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

/* ── Tools (read-only) ── */

const TOOLS = [
  {
    name: "get_schedule",
    title: "Get schedule",
    description: "Booked appointments for a day or a range of days (shop's time zone). Defaults to today.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Start day as YYYY-MM-DD. Defaults to today." },
        days: { type: "integer", minimum: 1, maximum: 14, description: "How many days to include (1–14). Default 1." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_booking_requests",
    title: "List booking requests",
    description: "Booking requests waiting for a response (new or pending), newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 25, description: "Max results (default 10)." } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "find_client",
    title: "Find a client",
    description: "Look up clients by name, phone, or email. Returns contact info, VIP status, visit count, and recent notes.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Part of a name, phone number, or email." } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "payments_summary",
    title: "Payments summary",
    description: "Card payments taken through Stripe for today, this week, or this month: total, count, and recent payments.",
    inputSchema: {
      type: "object",
      properties: { period: { type: "string", enum: ["today", "week", "month"], description: "Default week." } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "recent_messages",
    title: "Recent messages",
    description: "Recent client text conversations, newest first, with whether each has unread messages.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Max conversations (default 10)." },
        unread_only: { type: "boolean", description: "Only conversations with unread messages." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_website_info",
    title: "Website info",
    description: "The shop's website: address, template, business info, hours, and services with prices.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "confirm_booking_request",
    title: "Confirm a booking request",
    description:
      "Confirm a booking request (use request_id from list_booking_requests). Two steps: call without confirm_code to get a preview, " +
      "show it to the owner, and only after the owner clearly says yes call again with the confirm_code.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        confirm_code: { type: "string", description: "Only after the owner approves the preview." },
      },
      required: ["request_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "send_payment_link",
    title: "Text a client a payment link",
    description:
      "Create a card payment link (deposit or payment) and text it to a client. Two steps: call without confirm_code to get a preview, " +
      "show it to the owner, and only after the owner clearly says yes call again with the confirm_code.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client name or phone number." },
        amount: { type: "number", description: "Amount in dollars, e.g. 50." },
        kind: { type: "string", enum: ["deposit", "payment"], description: "Default deposit." },
        request_id: { type: "string", description: "Optional booking request this is for." },
        confirm_code: { type: "string", description: "Only after the owner approves the preview." },
      },
      required: ["client", "amount"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "text_client",
    title: "Text a client",
    description:
      "Send a text message to a client from the shop's number. Two steps: call without confirm_code to get a preview, " +
      "show it to the owner, and only after the owner clearly says yes call again with the confirm_code.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client name or phone number." },
        message: { type: "string", maxLength: 600 },
        confirm_code: { type: "string", description: "Only after the owner approves the preview." },
      },
      required: ["client", "message"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

const ACTION_TOOLS = new Set(["confirm_booking_request", "send_payment_link", "text_client"]);
const ACTIONS_PER_DAY = 30;
const CONFIRM_MINUTES = 10;

async function toolGetSchedule(ctx, args) {
  const tz = tzOf(ctx.tenant);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(args.date || "")) ? args.date : dayKey(new Date(), tz);
  const days = Math.min(Math.max(parseInt(args.days, 10) || 1, 1), 14);
  const end = addDays(start, days - 1);
  const snap = await ctx.tenantRef.collection("bookingRequests").orderBy("createdAt", "desc").limit(500).get();
  const rows = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const status = String(d.status || "").toLowerCase();
    if (!BOOKED.has(status)) return;
    const s = appointmentStart(d);
    if (!s) return;
    const k = dayKey(s, tz);
    if (k < start || k > end) return;
    rows.push({
      when: whenLabel(s, tz),
      sort: s.getTime(),
      client: String(d.customerName || "Client"),
      service: String(d.serviceName || ""),
      with: String(d.assignedMemberName || ""),
      status,
      minutes: Number(d.durationMinutes) || 60,
    });
  });
  rows.sort((a, b) => a.sort - b.sort);
  rows.forEach((r) => delete r.sort);
  return textResult({ from: start, to: end, timeZone: tz, count: rows.length, appointments: rows.slice(0, 60) });
}

async function toolListRequests(ctx, args) {
  const tz = tzOf(ctx.tenant);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 25);
  const snap = await ctx.tenantRef.collection("bookingRequests").orderBy("createdAt", "desc").limit(300).get();
  const rows = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const status = String(d.status || "").toLowerCase();
    if (!REQUEST.has(status)) return;
    const s = appointmentStart(d);
    const created = toDate(d.createdAt);
    rows.push({
      request_id: doc.id,
      client: String(d.customerName || "Client"),
      phone: String(d.customerPhone || ""),
      service: String(d.serviceName || ""),
      requestedFor: s ? whenLabel(s, tz) : String(d.preferredTime || ""),
      received: created ? whenLabel(created, tz) : "",
      status,
      notes: String(d.notes || "").slice(0, 300),
    });
  });
  return textResult({ count: rows.length, requests: rows.slice(0, limit) });
}

async function toolFindClient(ctx, args) {
  const q = String(args.query || "").trim().toLowerCase();
  if (q.length < 2) return textResult("Give at least 2 characters to search for.");
  const digits = q.replace(/\D/g, "");
  const snap = await ctx.tenantRef.collection("customers").limit(1000).get();
  const hits = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const name = String(d.name || "");
    const phone = String(d.phone || "");
    const email = String(d.email || "");
    const match =
      name.toLowerCase().includes(q) ||
      email.toLowerCase().includes(q) ||
      (digits.length >= 4 && phone.replace(/\D/g, "").includes(digits));
    if (!match) return;
    const notes = (Array.isArray(d.noteEntries) ? d.noteEntries : []).slice(0, 3).map((n) => String(n.body || "").slice(0, 200));
    if (!notes.length && d.notes) notes.push(String(d.notes).slice(0, 200));
    hits.push({ name: name || "Client", phone, email, vip: !!d.vip, visits: Number(d.totalAppointments) || 0, recentNotes: notes });
  });
  return textResult({ count: hits.length, clients: hits.slice(0, 10) });
}

async function toolPayments(ctx, args, deps) {
  const tz = tzOf(ctx.tenant);
  const period = ["today", "week", "month"].includes(args.period) ? args.period : "week";
  const accountId = String(ctx.tenant.stripeAccountId || "").trim();
  if (!accountId) return textResult("Card payments aren't set up for this shop yet (no Stripe account connected).");
  const secret = deps.stripeSecretKey.value();
  if (!secret) return textResult("Payments are unavailable right now.");
  const now = new Date();
  const today = dayKey(now, tz);
  let fromKey = today;
  if (period === "week") fromKey = addDays(today, -6);
  if (period === "month") fromKey = today.slice(0, 8) + "01";
  // Midnight of fromKey in the shop's time zone, approximated via a UTC offset probe.
  const probe = new Date(`${fromKey}T12:00:00Z`);
  const offsetMin = (new Date(probe.toLocaleString("en-US", { timeZone: "UTC" })) - new Date(probe.toLocaleString("en-US", { timeZone: tz }))) / 60000;
  const fromTs = Math.floor((Date.parse(`${fromKey}T00:00:00Z`) + offsetMin * 60000) / 1000);
  const stripe = new deps.Stripe(secret, { apiVersion: "2024-11-20.acacia" });
  const list = await stripe.balanceTransactions.list({ limit: 100, created: { gte: fromTs }, type: "charge" }, { stripeAccount: accountId });
  const tx = list.data || [];
  const gross = tx.reduce((s, t) => s + (t.amount || 0), 0);
  const net = tx.reduce((s, t) => s + (t.net || 0), 0);
  const recent = tx.slice(0, 8).map((t) => ({ when: whenLabel(new Date(t.created * 1000), tz), amount: money(t.amount), description: String(t.description || "") }));
  return textResult({
    period,
    from: fromKey,
    payments: tx.length,
    total: money(gross),
    afterFees: money(net),
    recent,
    note: list.has_more ? "Showing the most recent 100 payments in this period." : undefined,
  });
}

async function toolRecentMessages(ctx, args) {
  const tz = tzOf(ctx.tenant);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 25);
  const user = (await db().collection("users").doc(ctx.uid).get()).data() || {};
  const readMap = user.smsThreadRead || {};
  const readSince = typeof user.smsReadSince === "number" ? user.smsReadSince : 0;
  const snap = await ctx.tenantRef.collection("smsThreads").orderBy("lastMessageAt", "desc").limit(100).get();
  const rows = [];
  snap.forEach((doc) => {
    const d = doc.data() || {};
    const at = toDate(d.lastMessageAt);
    const readAt = Number(readMap[doc.id] || 0);
    const unread = !!at && readAt !== -1 && at.getTime() > Math.max(readAt, readSince);
    rows.push({
      client: String(d.clientName || d.counterpartPhone || doc.id),
      lastMessage: String(d.lastMessageBody || "").slice(0, 200),
      when: at ? whenLabel(at, tz) : "",
      unread,
    });
  });
  const list = args.unread_only ? rows.filter((r) => r.unread) : rows;
  return textResult({ count: list.length, conversations: list.slice(0, limit) });
}

async function toolWebsite(ctx) {
  const t = ctx.tenant;
  const services = [];
  const snap = await ctx.tenantRef.collection("services").limit(100).get();
  snap.forEach((doc) => {
    const d = doc.data() || {};
    if (d.isActive === false) return;
    services.push({ name: String(d.name || ""), price: d.price ? "$" + Number(d.price) : "", minutes: Number(d.durationMinutes) || undefined });
  });
  const slug = String(t.slug || "");
  const custom = t.customDomainStatus === "active" && t.customDomain ? "https://www." + String(t.customDomain).replace(/^www\./, "") : "";
  return textResult({
    name: String((t.webCopyOverrides && t.webCopyOverrides["wc.site.displayName"]) || t.displayName || t.businessName || ""),
    website: custom || (slug ? `https://${slug}.getbookking.com` : ""),
    template: String(t.webThemeId || ""),
    tagline: String(t.tagline || ""),
    about: String(t.aboutText || "").slice(0, 600),
    phone: String(t.contactPhone || ""),
    email: String(t.contactEmail || ""),
    address: [t.contactAddress, t.contactAddressSuite, t.serviceArea].filter(Boolean).join(", "),
    hours: t.businessHoursWeekly || t.businessHours || "",
    services,
  });
}

/* ── Actions: preview first, run only with the code from the preview ── */

function digits(v) { return String(v || "").replace(/\D/g, ""); }
function e164(v) {
  const d = digits(v);
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "";
}

/** Find one client by name or phone. Returns { name, phone } or { error }. */
async function resolveClient(ctx, query) {
  const q = String(query || "").trim();
  if (!q) return { error: "Say which client." };
  const asPhone = e164(q);
  const snap = await ctx.tenantRef.collection("customers").limit(1000).get();
  const all = snap.docs.map((d) => d.data() || {});
  if (asPhone) {
    const hit = all.find((c) => e164(c.phone) === asPhone);
    return { name: hit ? String(hit.name || "") : "", phone: asPhone };
  }
  const lower = q.toLowerCase();
  let hits = all.filter((c) => String(c.name || "").toLowerCase() === lower);
  if (!hits.length) hits = all.filter((c) => String(c.name || "").toLowerCase().includes(lower));
  hits = hits.filter((c) => e164(c.phone));
  if (!hits.length) return { error: "No client with a phone number matches \"" + q + "\"." };
  if (hits.length > 1) {
    return { error: "More than one client matches \"" + q + "\": " + hits.slice(0, 5).map((c) => c.name + " (" + c.phone + ")").join(", ") + ". Ask the owner which one, then use the phone number." };
  }
  return { name: String(hits[0].name || ""), phone: e164(hits[0].phone) };
}

/** Build the plan for an action, or return { error }. */
async function planAction(ctx, name, args) {
  if (name === "confirm_booking_request") {
    const id = String(args.request_id || "").trim();
    if (!id) return { error: "request_id is required." };
    const snap = await ctx.tenantRef.collection("bookingRequests").doc(id).get();
    if (!snap.exists) return { error: "That booking request wasn't found." };
    const d = snap.data() || {};
    const status = String(d.status || "").toLowerCase();
    if (!REQUEST.has(status)) return { error: "This request is already \"" + status + "\"." };
    const s = appointmentStart(d);
    const when = s ? whenLabel(s, tzOf(ctx.tenant)) : String(d.preferredTime || "no time set");
    return {
      run: { requestId: id },
      preview: "Confirm " + (d.customerName || "this client") + "'s " + (d.serviceName || "booking") + " for " + when + ".",
    };
  }
  if (name === "send_payment_link") {
    const cents = Math.round(Number(args.amount) * 100);
    if (!Number.isFinite(cents) || cents < 50) return { error: "Amount must be at least $0.50." };
    if (cents > 500000) return { error: "Amounts over $5,000 need to be sent from the app." };
    const kind = args.kind === "payment" ? "payment" : "deposit";
    const who = await resolveClient(ctx, args.client);
    if (who.error) return who;
    return {
      run: { to: who.phone, clientName: who.name, cents, kind, requestId: String(args.request_id || "").trim() },
      preview: "Text " + (who.name || "client") + " (" + who.phone + ") a " + kind + " link for " + money(cents) + ". Card fees are added the same way as in the app.",
    };
  }
  if (name === "text_client") {
    const body = String(args.message || "").trim().slice(0, 600);
    if (!body) return { error: "The message is empty." };
    const who = await resolveClient(ctx, args.client);
    if (who.error) return who;
    return {
      run: { to: who.phone, clientName: who.name, body },
      preview: "Text " + (who.name || "client") + " (" + who.phone + "): \"" + body + "\"",
    };
  }
  return { error: "Unknown action." };
}

/** Run a confirmed action through the same functions the app uses. */
async function runAction(ctx, name, run, deps) {
  const callAs = (fnName, data) => {
    const fn = deps.exportsObj && deps.exportsObj[fnName];
    if (!fn || typeof fn.run !== "function") throw new Error(fnName + " unavailable");
    return fn.run(data, { auth: { uid: ctx.uid, token: {} } });
  };
  if (name === "confirm_booking_request") {
    await callAs("updateBookingRequestStatus", { requestId: run.requestId, status: "confirmed" });
    return "Confirmed. It's on the calendar now.";
  }
  if (name === "send_payment_link") {
    const label = run.kind === "deposit" ? "Deposit" : "Payment";
    const link = await callAs("createDepositLink", {
      serviceAmountCents: run.cents,
      bookingRequestId: run.requestId || undefined,
      paymentKind: run.kind,
      productName: label,
    });
    const url = link && link.url;
    if (!url) throw new Error("No link returned");
    const dollars = (run.cents / 100).toFixed(2);
    await callAs("sendClientSms", {
      to: run.to,
      body: label + ": $" + dollars + "\nPay here: " + url,
      clientName: run.clientName,
      threadId: run.to,
      paymentKind: run.kind,
      amountCents: run.cents,
      paymentUrl: url,
      threadPreview: label + " · $" + dollars,
    });
    return "Sent. " + (run.clientName || run.to) + " got a " + run.kind + " link for $" + dollars + ".";
  }
  if (name === "text_client") {
    await callAs("sendClientSms", { to: run.to, body: run.body, clientName: run.clientName, threadId: run.to, threadPreview: run.body.slice(0, 120) });
    return "Sent to " + (run.clientName || run.to) + ".";
  }
  throw new Error("Unknown action");
}

async function handleAction(ctx, name, args, deps, auth) {
  if (auth.actions === false) {
    return { ...textResult("Actions are turned off for this connection. The owner can turn them on in Get Bookking (Settings → Connect an AI assistant)."), isError: true };
  }
  const pendingCol = ctx.tenantRef.collection("mcpPending");
  const code = String(args.confirm_code || "").trim().toUpperCase();

  if (!code) {
    const plan = await planAction(ctx, name, args);
    if (plan.error) return { ...textResult(plan.error), isError: true };
    const newCode = crypto.randomBytes(3).toString("hex").toUpperCase();
    await pendingCol.doc(newCode).set({
      tool: name,
      run: plan.run,
      preview: plan.preview,
      keyId: auth.keyId,
      expiresAt: new Date(Date.now() + CONFIRM_MINUTES * 60000),
      usedAt: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return textResult({
      status: "needs_owner_approval",
      preview: plan.preview,
      confirm_code: newCode,
      next_step: "Show the preview to the owner and ask them to approve it. Only if they clearly say yes, call " + name + " again with confirm_code \"" + newCode + "\". It expires in " + CONFIRM_MINUTES + " minutes.",
    });
  }

  // Second step: claim the pending action and the daily allowance in one transaction.
  const pendRef = pendingCol.doc(code);
  const keyRef = db().collection("mcpKeys").doc(auth.keyId);
  let pending;
  try {
    pending = await db().runTransaction(async (tx) => {
      const p = await tx.get(pendRef);
      const k = await tx.get(keyRef);
      const d = p.exists ? p.data() || {} : null;
      if (!d || d.tool !== name || d.keyId !== auth.keyId) throw { msg: "That confirm code isn't valid. Start over without a confirm_code." };
      if (d.usedAt) throw { msg: "That action was already done." };
      if (toDate(d.expiresAt) < new Date()) throw { msg: "That preview expired. Start over without a confirm_code." };
      const kd = k.data() || {};
      const day = new Date().toISOString().slice(0, 10);
      const count = kd.actionDay === day ? (kd.actionCount || 0) + 1 : 1;
      if (count > ACTIONS_PER_DAY) throw { msg: "This connection has hit its limit of " + ACTIONS_PER_DAY + " actions today." };
      tx.set(keyRef, { actionDay: day, actionCount: count }, { merge: true });
      tx.set(pendRef, { usedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return d;
    });
  } catch (e) {
    if (e && e.msg) return { ...textResult(e.msg), isError: true };
    throw e;
  }
  try {
    const done = await runAction(ctx, name, pending.run, deps);
    await pendRef.set({ ok: true }, { merge: true });
    return textResult({ status: "done", result: done });
  } catch (e) {
    const msg = (e && e.message) || "It didn't go through.";
    await pendRef.set({ ok: false, error: String(msg).slice(0, 300) }, { merge: true });
    return { ...textResult("It didn't go through: " + msg), isError: true };
  }
}

const HANDLERS = {
  get_schedule: toolGetSchedule,
  list_booking_requests: toolListRequests,
  find_client: toolFindClient,
  payments_summary: toolPayments,
  recent_messages: toolRecentMessages,
  get_website_info: toolWebsite,
};

/* ── Auth and limits ── */

function rawKeyFrom(req) {
  const m = String(req.path || "").match(/\/k\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  const h = String(req.get("authorization") || "");
  const b = h.match(/^Bearer\s+(.+)$/i);
  return b ? b[1].trim() : "";
}

/** Returns { uid, tenantId, keyId } or throws { status, message }. Also enforces rate limits. */
async function authenticate(req) {
  const raw = rawKeyFrom(req);
  if (!raw || !raw.startsWith(KEY_PREFIX)) throw { status: 401, message: "Sign in to Get Bookking to connect.", oauth: true };
  // "Sign in with Get Bookking" tokens point at their connection; link keys are the connection.
  let keyId = hashKey(raw);
  if (raw.startsWith(oauth.ACCESS_PREFIX)) {
    const linkKey = await db().collection("mcpKeys").doc(keyId).get();
    if (!linkKey.exists) keyId = await oauth.grantForAccessToken(raw);
  }
  const ref = db().collection("mcpKeys").doc(keyId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw { status: 401, message: "This connection isn't valid. Reconnect Get Bookking.", oauth: "invalid_token" };
    const k = snap.data() || {};
    if (k.revokedAt) throw { status: 401, message: "This connection was turned off in Get Bookking. Reconnect to use it again.", oauth: "invalid_token" };
    const now = new Date();
    const minute = now.toISOString().slice(0, 16);
    const day = now.toISOString().slice(0, 10);
    const minuteCount = k.minuteKey === minute ? (k.minuteCount || 0) + 1 : 1;
    const dayCount = k.dayKey === day ? (k.dayCount || 0) + 1 : 1;
    if (minuteCount > PER_MINUTE || dayCount > PER_DAY) throw { status: 429, message: "Too many requests. Try again in a minute." };
    tx.set(ref, { minuteKey: minute, minuteCount, dayKey: day, dayCount, lastUsedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { uid: k.uid, tenantId: k.tenantId, keyId, keyName: k.name || "", actions: k.actions !== false };
  });
}

/* ── JSON-RPC ── */

async function handleRpc(msg, auth, deps) {
  const id = msg.id;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid request");
  // Notifications get no response.
  if (id === undefined || id === null) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params && msg.params.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Get Bookking: this shop's schedule, booking requests, clients, payments, messages, and website. " +
          "Actions (confirm_booking_request, send_payment_link, text_client) always need the owner's yes: the first call returns a preview and confirm_code; " +
          "show the preview, wait for a clear yes, then call again with the code. Never approve on the owner's behalf. " +
          "Times are in the shop's time zone. Share client contact details only when the owner asks.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const isAction = ACTION_TOOLS.has(name);
      const handler = isAction ? null : HANDLERS[name];
      if (!handler && !isAction) return fail(-32602, `Unknown tool: ${name}`);
      const args = (msg.params && msg.params.arguments) || {};
      const tenantRef = db().collection("tenants").doc(auth.tenantId);
      const tenantSnap = await tenantRef.get();
      const tenant = tenantSnap.data() || {};
      // Phase 1: owners only.
      if (String(tenant.ownerUid || "") !== String(auth.uid)) {
        return reply({ ...textResult("Only the shop owner can use the AI assistant right now."), isError: true });
      }
      const ctx = { uid: auth.uid, tenantId: auth.tenantId, tenantRef, tenant };
      let result;
      try {
        result = isAction ? await handleAction(ctx, name, args, deps, auth) : await handler(ctx, args, deps);
      } catch (e) {
        console.warn("mcp tool error", name, e.message || e);
        result = { ...textResult("Something went wrong. Try again."), isError: true };
      }
      tenantRef.collection("mcpLog").add({
        tool: name,
        keyId: auth.keyId.slice(0, 12),
        keyName: auth.keyName,
        at: admin.firestore.FieldValue.serverTimestamp(),
        ok: !result.isError,
        ...(isAction ? { action: args.confirm_code ? "run" : "preview", detail: String((result.content && result.content[0] && result.content[0].text) || "").slice(0, 500) } : {}),
      }).catch(() => {});
      return reply(result);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

function registerMcpFunctions(exportsObj, depsIn) {
  const deps = { ...depsIn, exportsObj };
  exportsObj.mcpServer = functions
    .runWith({ secrets: [deps.stripeSecretKey, deps.twilioAccountSid, deps.twilioAuthToken].filter(Boolean), maxInstances: 3, memory: "256MB", timeoutSeconds: 60 })
    .https.onRequest(async (req, res) => {
      res.set("Cache-Control", "no-store");
      // Sign-in pages for ChatGPT, Claude, etc. (www.getbookking.com/.well-known/* and /oauth/*).
      if (await oauth.handleOAuthHttp(req, res)) return;
      if (req.method === "OPTIONS") {
        res.set("Access-Control-Allow-Origin", "*");
        res.set("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
        res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.set("Access-Control-Expose-Headers", "www-authenticate, mcp-session-id");
        return res.status(204).send("");
      }
      if (req.method !== "POST") {
        // No server-to-client stream in phase 1.
        return res.status(405).set("Allow", "POST").send("Method not allowed");
      }
      let auth;
      try {
        auth = await authenticate(req);
      } catch (e) {
        const status = e && e.status ? e.status : 500;
        // Tells the AI app where to sign in, so it can show "Connect".
        if (status === 401) {
          res.set("Access-Control-Allow-Origin", "*");
          res.set("WWW-Authenticate", oauth.wwwAuthenticate(typeof (e && e.oauth) === "string" ? e.oauth : null));
        }
        return res.status(status).json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: (e && e.message) || "Unauthorized" } });
      }
      const body = req.body;
      try {
        if (Array.isArray(body)) {
          const out = (await Promise.all(body.map((m) => handleRpc(m, auth, deps)))).filter(Boolean);
          return out.length ? res.json(out) : res.status(202).send("");
        }
        const out = await handleRpc(body || {}, auth, deps);
        return out ? res.json(out) : res.status(202).send("");
      } catch (e) {
        console.error("mcpServer", e);
        return res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      }
    });

  /* Keys: created and revoked in the web app (Settings → AI assistant). */
  async function ownerContext(context) {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "Sign in first.");
    const uid = context.auth.uid;
    const user = (await db().collection("users").doc(uid).get()).data() || {};
    const tenantId = String(user.tenantId || "");
    if (!tenantId) throw new functions.https.HttpsError("failed-precondition", "No shop found for this account.");
    const tenant = (await db().collection("tenants").doc(tenantId).get()).data() || {};
    if (String(tenant.ownerUid || "") !== uid) throw new functions.https.HttpsError("permission-denied", "Only the shop owner can manage AI assistant keys.");
    const email = context.auth.token.email || user.email || "";
    const allowed = tenant.mcpEnabled === true || allowListed(email);
    return { uid, tenantId, tenant, allowed };
  }

  oauth.registerMcpOAuthCallables(exportsObj, { ownerContext });

  exportsObj.createMcpKey = functions.https.onCall(async (data, context) => {
    const o = await ownerContext(context);
    if (!o.allowed) throw new functions.https.HttpsError("permission-denied", "The AI assistant is in early access and isn't on for this shop yet.");
    const active = await db().collection("mcpKeys").where("uid", "==", o.uid).where("revokedAt", "==", null).get();
    if (active.size >= 5) throw new functions.https.HttpsError("resource-exhausted", "You have 5 active keys. Revoke one first.");
    const raw = newRawKey();
    const name = String((data && data.name) || "AI assistant").trim().slice(0, 40) || "AI assistant";
    await db().collection("mcpKeys").doc(hashKey(raw)).set({
      uid: o.uid,
      tenantId: o.tenantId,
      name,
      hint: raw.slice(-4),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedAt: null,
    });
    // The full key is only ever returned here, once.
    return { key: raw, name, connectorUrl: `${connectorBaseUrl()}/k/${raw}`, serverUrl: connectorBaseUrl() };
  });

  exportsObj.listMcpKeys = functions.https.onCall(async (data, context) => {
    const o = await ownerContext(context);
    const snap = await db().collection("mcpKeys").where("uid", "==", o.uid).get();
    const keys = snap.docs
      .map((d) => {
        const k = d.data() || {};
        return {
          id: d.id.slice(0, 16),
          name: k.name || "AI assistant",
          hint: k.hint || "",
          createdAt: toDate(k.createdAt) ? toDate(k.createdAt).toISOString() : null,
          lastUsedAt: toDate(k.lastUsedAt) ? toDate(k.lastUsedAt).toISOString() : null,
          revoked: !!k.revokedAt,
          actions: k.actions !== false,
          kind: k.kind === "oauth" ? "signin" : "link",
        };
      })
      .filter((k) => !k.revoked)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { allowed: o.allowed, keys, serverUrl: connectorBaseUrl(), connectUrl: oauth.resourceUrl() };
  });

  exportsObj.setMcpKeyActions = functions.https.onCall(async (data, context) => {
    const o = await ownerContext(context);
    const prefix = String((data && data.id) || "");
    if (prefix.length < 8) throw new functions.https.HttpsError("invalid-argument", "Missing key id.");
    const snap = await db().collection("mcpKeys").where("uid", "==", o.uid).get();
    const doc = snap.docs.find((d) => d.id.startsWith(prefix));
    if (!doc) throw new functions.https.HttpsError("not-found", "Key not found.");
    await doc.ref.set({ actions: data.actions === true }, { merge: true });
    return { ok: true };
  });

  exportsObj.revokeMcpKey = functions.https.onCall(async (data, context) => {
    const o = await ownerContext(context);
    const prefix = String((data && data.id) || "");
    if (prefix.length < 8) throw new functions.https.HttpsError("invalid-argument", "Missing key id.");
    const snap = await db().collection("mcpKeys").where("uid", "==", o.uid).get();
    const doc = snap.docs.find((d) => d.id.startsWith(prefix));
    if (!doc) throw new functions.https.HttpsError("not-found", "Key not found.");
    await doc.ref.set({ revokedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true };
  });
}

module.exports = { registerMcpFunctions, TOOLS, hashKey, _test: { HANDLERS, handleRpc, planAction, handleAction, setDb: (d) => { dbOverride = d; } } };
