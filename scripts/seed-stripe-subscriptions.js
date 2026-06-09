#!/usr/bin/env node
/**
 * Seed N provider accounts with real Stripe subscriptions and Connect customer payments.
 * Subscriptions can be backdated (default 3 months). Connect charges use the platform 1% fee.
 *
 * Usage (from Test/):
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe-subscriptions.js
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe-subscriptions.js --count=50 --with-connect-fees
 *
 * Auth: firebase login OR GOOGLE_APPLICATION_CREDENTIALS
 * Price IDs: STRIPE_SUBSCRIPTION_PRICE_IDS env (JSON) or functions/stripe-subscription-price-ids.example.json
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { GoogleAuth } = require(path.join(
  __dirname,
  "../functions/node_modules/google-auth-library"
));
const { Firestore, FieldValue, Timestamp } = require(path.join(
  __dirname,
  "../functions/node_modules/@google-cloud/firestore"
));
const Stripe = require(path.join(__dirname, "../functions/node_modules/stripe"));
const {
  defaultServicesByIndustry,
  resolveWebThemeId,
  slugFromBusiness,
} = require(path.join(__dirname, "../functions/signupPayloads"));

const DEFAULT_PROJECT = "test-app-96812";
const DEFAULT_PASSWORD = process.env.DEMO_ACCOUNT_PASSWORD || "BookkingDemo2026!";
const DEFAULT_COUNT = 50;
const DEFAULT_MEMBER_MONTHS = 3;
const DEFAULT_PAYMENTS_PER_TENANT = 30;
const PLATFORM_FEE_BPS = 100;
const STRIPE_API_VERSION = "2024-11-20.acacia";
const INDUSTRIES = ["barber", "hair", "nails", "tattoos"];
const PLANS = ["solo", "studio", "shop"];
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

const FIREBASE_CLI_CLIENT_ID =
  process.env.FIREBASE_CLIENT_ID ||
  "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const FIREBASE_CLI_CLIENT_SECRET =
  process.env.FIREBASE_CLIENT_SECRET || "j9iVZfS8kkCEFUPaAeJV0sAi";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firebaseToolsRefreshToken() {
  const cfgPath = path.join(
    os.homedir(),
    ".config",
    "configstore",
    "firebase-tools.json"
  );
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  return cfg && cfg.tokens && cfg.tokens.refresh_token;
}

async function createGoogleClients(projectId) {
  const refresh = firebaseToolsRefreshToken();
  if (!refresh) {
    throw new Error(
      "No credentials. Run: firebase login — or set GOOGLE_APPLICATION_CREDENTIALS."
    );
  }
  const auth = new GoogleAuth({
    credentials: {
      type: "authorized_user",
      client_id: FIREBASE_CLI_CLIENT_ID,
      client_secret: FIREBASE_CLI_CLIENT_SECRET,
      refresh_token: refresh,
    },
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const authClient = await auth.getClient();
  const db = new Firestore({ projectId, authClient });
  return { db, auth, authClient };
}

async function getAccessToken(auth) {
  return auth.getAccessToken();
}

async function lookupAuthUserByEmail(projectId, accessToken, email) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:lookup`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: [email] }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const user =
    data && data.users && data.users.find((u) => u.email === email);
  return user ? { uid: user.localId, email: user.email } : null;
}

async function createOrUpdateAuthUser(projectId, accessToken, { email, password, displayName }) {
  const existing = await lookupAuthUserByEmail(projectId, accessToken, email);
  if (existing) {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:update`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          localId: existing.uid,
          password,
          displayName,
          emailVerified: true,
        }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Auth update failed for ${email}: ${res.status} ${err}`);
    }
    return { uid: existing.uid, created: false };
  }

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        displayName,
        emailVerified: true,
      }),
    }
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error(
      `Auth create failed for ${email}: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return { uid: body.localId, created: true };
}

function platformFeeCents(amountCents) {
  const n = Math.round(Number(amountCents));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.round((n * PLATFORM_FEE_BPS) / 10000));
}

function memberStartDate(memberMonths) {
  if (!memberMonths || memberMonths <= 0) return new Date();
  return new Date(Date.now() - memberMonths * SECONDS_PER_MONTH * 1000);
}

function loadPriceIds() {
  const raw =
    process.env.STRIPE_SUBSCRIPTION_PRICE_IDS ||
    fs.readFileSync(
      path.join(__dirname, "../functions/stripe-subscription-price-ids.example.json"),
      "utf8"
    );
  const map = JSON.parse(String(raw).trim());
  for (const plan of PLANS) {
    if (!map[plan] || typeof map[plan] !== "string") {
      throw new Error(`Missing Stripe price id for plan "${plan}" in price IDs JSON.`);
    }
  }
  return map;
}

function parseArgs(argv) {
  const out = {
    project: DEFAULT_PROJECT,
    password: DEFAULT_PASSWORD,
    count: DEFAULT_COUNT,
    plan: "solo",
    mixPlans: false,
    withConnectFees: false,
    connectPaymentCents: 5000,
    connectPaymentMinCents: null,
    connectPaymentMaxCents: null,
    paymentsPerTenant: null,
    memberMonths: DEFAULT_MEMBER_MONTHS,
    startIndex: 1,
    dryRun: false,
    paymentsOnly: false,
    subscriptionsOnly: false,
    forcePayments: false,
    forceSubscriptions: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) out.project = arg.slice(10).trim();
    else if (arg.startsWith("--password=")) out.password = arg.slice(11);
    else if (arg.startsWith("--count=")) {
      out.count = Math.max(1, parseInt(arg.slice(8), 10) || DEFAULT_COUNT);
    } else if (arg.startsWith("--plan=")) out.plan = arg.slice(7).trim().toLowerCase();
    else if (arg.startsWith("--connect-payment-cents=")) {
      out.connectPaymentCents = Math.max(
        50,
        parseInt(arg.slice(24), 10) || 5000
      );
    } else if (arg.startsWith("--connect-payment-min-cents=")) {
      out.connectPaymentMinCents = Math.max(50, parseInt(arg.slice(28), 10) || 3000);
    } else if (arg.startsWith("--connect-payment-max-cents=")) {
      out.connectPaymentMaxCents = Math.max(50, parseInt(arg.slice(28), 10) || 12000);
    } else if (arg.startsWith("--payments-per-tenant=")) {
      out.paymentsPerTenant = Math.max(1, parseInt(arg.slice(22), 10) || DEFAULT_PAYMENTS_PER_TENANT);
    } else if (arg.startsWith("--member-months=")) {
      out.memberMonths = Math.max(0, parseInt(arg.slice(16), 10) || 0);
    } else if (arg.startsWith("--start-index=")) {
      out.startIndex = Math.max(1, parseInt(arg.slice(14), 10) || 1);
    } else if (arg === "--mix-plans") out.mixPlans = true;
    else if (arg === "--with-connect-fees") out.withConnectFees = true;
    else if (arg === "--payments-only") out.paymentsOnly = true;
    else if (arg === "--subscriptions-only") out.subscriptionsOnly = true;
    else if (arg === "--force-payments") out.forcePayments = true;
    else if (arg === "--force-subscriptions") out.forceSubscriptions = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  if (!out.mixPlans && !PLANS.includes(out.plan)) {
    throw new Error(`Unknown plan "${out.plan}". Use solo, studio, shop, or --mix-plans.`);
  }
  if (out.paymentsPerTenant == null) {
    out.paymentsPerTenant = out.withConnectFees ? DEFAULT_PAYMENTS_PER_TENANT : 0;
  }
  if (out.connectPaymentMinCents == null) {
    out.connectPaymentMinCents = Math.max(50, Math.round(out.connectPaymentCents * 0.6));
  }
  if (out.connectPaymentMaxCents == null) {
    out.connectPaymentMaxCents = Math.max(
      out.connectPaymentMinCents,
      Math.round(out.connectPaymentCents * 1.4)
    );
  }
  if (out.subscriptionsOnly) {
    out.withConnectFees = false;
    out.paymentsPerTenant = 0;
    out.paymentsOnly = false;
  }
  return out;
}

function seedEmail(index) {
  return `stripe-seed-${String(index).padStart(3, "0")}@getbookking.com`;
}

function seedProfile(index, plan) {
  const industry = INDUSTRIES[(index - 1) % INDUSTRIES.length];
  const businessName = `Stripe Seed Studio ${String(index).padStart(3, "0")}`;
  const firstName = "Seed";
  const lastName = `User${String(index).padStart(3, "0")}`;
  return {
    email: seedEmail(index),
    firstName,
    lastName,
    displayName: `${firstName} ${lastName}`,
    businessName,
    slug: `${slugFromBusiness(businessName)}-${index}`,
    industry,
    plan,
    city: "Austin",
    stateAbbr: "TX",
    phone: "+1512555" + String(1000 + (index % 9000)).slice(-4),
  };
}

function paymentAmountCents(args, tenantIndex, paymentIndex) {
  const min = args.connectPaymentMinCents;
  const max = args.connectPaymentMaxCents;
  if (min >= max) return min;
  const span = max - min + 1;
  const seed = tenantIndex * 9973 + paymentIndex * 7919;
  return min + (seed % span);
}

async function upsertDefaultServices(db, tenantRef, industry) {
  const services = defaultServicesByIndustry[industry] || [];
  const now = FieldValue.serverTimestamp();
  for (let i = 0; i < services.length; i++) {
    const svc = services[i];
    const slug = svc.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    await tenantRef.collection("services").doc().set({
      name: svc.name,
      slug,
      durationMinutes: svc.durationMinutes,
      price: 0,
      sortOrder: i,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function provisionFirestore(db, uid, profile, memberMonths) {
  const {
    email,
    firstName,
    lastName,
    displayName,
    businessName,
    slug,
    industry,
    plan,
    city,
    stateAbbr,
    phone,
  } = profile;

  const memberStartedAt = Timestamp.fromDate(memberStartDate(memberMonths));

  const existingUser = await db.collection("users").doc(uid).get();
  if (existingUser.exists && existingUser.data().tenantId) {
    const tenantId = existingUser.data().tenantId;
    const tenantSnap = await db.collection("tenants").doc(tenantId).get();
    return {
      tenantId,
      slug: tenantSnap.exists ? tenantSnap.data().slug || slug : slug,
      reused: true,
    };
  }

  const webThemeId = resolveWebThemeId(industry, "portfolio");
  const serviceArea = `${city}, ${stateAbbr}`;
  const tenantRef = db.collection("tenants").doc();
  const tenantId = tenantRef.id;

  const tenantData = {
    ownerUid: uid,
    ownerId: uid,
    businessName,
    displayName: businessName,
    slug,
    industry,
    teamSize: plan === "solo" ? "solo" : plan,
    city,
    contactState: stateAbbr,
    serviceArea,
    contactPhone: phone,
    webThemeId,
    resolvedWebThemeId: webThemeId,
    templatePreset: "portfolio",
    subscriptionPlan: plan,
    subscriptionStatus: "active",
    subscriptionStartedAt: memberStartedAt,
    trialStartDate: memberStartedAt,
    isActive: true,
    isStripeSeedAccount: true,
    bookingModeDefault: "request",
    requireApprovalForSlotBookings: true,
    maxBookingWindowDays: 30,
    bufferMinutes: 15,
    shopEnabled: false,
    contactEmail: email,
    createdAt: memberStartedAt,
    updatedAt: FieldValue.serverTimestamp(),
  };

  const userDoc = {
    email,
    firstName,
    lastName,
    displayName,
    name: displayName,
    tenantId,
    tenantSlug: slug,
    role: "owner",
    accessRole: "owner",
    business: businessName,
    industry,
    subscriptionPlan: plan,
    subscriptionStatus: "active",
    profilePhotoUrl: "",
    availability: {
      timeSlots: [{ open: 9, close: 18, type: "open_booking" }],
      daysOpen: [1, 2, 3, 4, 5, 6],
      timeZone: "America/Chicago",
    },
    workflow: {
      confirmationType: "request_approve",
      responseTimeHours: 24,
    },
    createdAt: memberStartedAt,
    updatedAt: FieldValue.serverTimestamp(),
  };

  const batch = db.batch();
  batch.set(tenantRef, tenantData);
  batch.set(db.collection("users").doc(uid), userDoc);
  await batch.commit();
  await upsertDefaultServices(db, tenantRef, industry);

  return { tenantId, slug, reused: false };
}

async function findSeedCustomerByEmail(stripe, email) {
  const list = await stripe.customers.list({ email, limit: 10 });
  if (!list.data.length) return null;
  const seeded = list.data.find((c) => c.metadata && c.metadata.seed === "stripe-subscriptions");
  return seeded || list.data[0];
}

async function ensureSeedCustomer(stripe, profile, uid) {
  const existing = await findSeedCustomerByEmail(stripe, profile.email);
  if (existing) {
    await stripe.customers.update(existing.id, {
      name: profile.displayName,
      invoice_settings: { default_payment_method: "pm_card_visa" },
      metadata: { firebaseUid: uid, seed: "stripe-subscriptions" },
    });
    try {
      await stripe.paymentMethods.attach("pm_card_visa", { customer: existing.id });
    } catch (_) {
      /* already attached */
    }
    return existing.id;
  }

  const customer = await stripe.customers.create({
    email: profile.email,
    name: profile.displayName,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    metadata: { firebaseUid: uid, seed: "stripe-subscriptions" },
  });
  return customer.id;
}

async function findActiveSubscriptionForCustomer(stripe, customerId) {
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "active",
    limit: 1,
  });
  return subs.data[0] || null;
}

async function payAllUnpaidSubscriptionInvoices(stripe, subscriptionId) {
  let invoicesPaidThisRun = 0;
  let revenueCollectedThisRun = 0;

  for (const status of ["draft", "open"]) {
    const list = await stripe.invoices.list({
      subscription: subscriptionId,
      status,
      limit: 24,
    });
    for (const inv of list.data) {
      try {
        let targetId = inv.id;
        if (inv.status === "draft") {
          const finalized = await stripe.invoices.finalizeInvoice(inv.id);
          targetId = finalized.id;
        }
        const paid = await stripe.invoices.pay(targetId);
        if (paid.status === "paid") {
          invoicesPaidThisRun += 1;
          revenueCollectedThisRun += paid.amount_paid || 0;
        }
      } catch (_) {
        /* skip unpayable invoice */
      }
    }
  }

  const paidInvoices = await stripe.invoices.list({
    subscription: subscriptionId,
    status: "paid",
    limit: 24,
  });
  const subscriptionRevenueCents = paidInvoices.data.reduce(
    (sum, inv) => sum + (inv.amount_paid || 0),
    0
  );

  return {
    invoicesPaidThisRun,
    revenueCollectedThisRun,
    subscriptionRevenueCents,
    invoiceCount: paidInvoices.data.length,
  };
}

async function billingFromSubscription(stripe, customerId, subscription) {
  const invoiceStats = await payAllUnpaidSubscriptionInvoices(stripe, subscription.id);
  return {
    customerId,
    subscriptionId: subscription.id,
    status: subscription.status,
    ...invoiceStats,
  };
}

async function ensureBackdatedSubscription(stripe, profile, priceId, uid, memberMonths, forceCreate) {
  const customerId = await ensureSeedCustomer(stripe, profile, uid);

  if (!forceCreate) {
    const existingSub = await findActiveSubscriptionForCustomer(stripe, customerId);
    if (existingSub) {
      const billing = await billingFromSubscription(stripe, customerId, existingSub);
      return { ...billing, reused: true };
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const startTs =
    memberMonths > 0 ? now - memberMonths * SECONDS_PER_MONTH : now;

  const subParams = {
    customer: customerId,
    items: [{ price: priceId }],
    metadata: { firebaseUid: uid, plan: profile.plan, seed: "stripe-subscriptions" },
    collection_method: "charge_automatically",
    default_payment_method: "pm_card_visa",
  };

  if (memberMonths > 0) {
    subParams.backdate_start_date = startTs;
    subParams.proration_behavior = "none";
  }

  const subscription = await stripe.subscriptions.create(subParams);
  const billing = await billingFromSubscription(stripe, customerId, subscription);
  return { ...billing, reused: false };
}

async function collectInvoicesForExistingSub(stripe, tenantData, profile, uid) {
  let customerId = (tenantData.stripeCustomerId || "").toString().trim();
  let subscriptionId = (tenantData.stripeSubscriptionId || "").toString().trim();

  if (!customerId) {
    customerId = await ensureSeedCustomer(stripe, profile, uid);
  }

  let subscription = null;
  if (subscriptionId) {
    try {
      subscription = await stripe.subscriptions.retrieve(subscriptionId);
      if (subscription.status !== "active" && subscription.status !== "trialing") {
        subscription = null;
      }
    } catch (_) {
      subscription = null;
    }
  }
  if (!subscription) {
    subscription = await findActiveSubscriptionForCustomer(stripe, customerId);
  }

  if (!subscription) {
    return null;
  }

  return billingFromSubscription(stripe, customerId, subscription);
}

async function createTestConnectAccount(stripe, email, displayName) {
  const descriptor = displayName
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .slice(0, 22)
    .toUpperCase() || "SEED STUDIO";
  const account = await stripe.accounts.create({
    type: "custom",
    country: "US",
    email,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      name: displayName.slice(0, 100),
      url: "https://getbookking.com",
      mcc: "7299",
    },
    settings: {
      payments: {
        statement_descriptor: descriptor,
      },
    },
    individual: {
      first_name: "Seed",
      last_name: "Provider",
      email,
      phone: "+15125550100",
      dob: { day: 1, month: 1, year: 1990 },
      address: {
        line1: "123 Main Street",
        city: "Austin",
        state: "TX",
        postal_code: "78701",
        country: "US",
      },
      ssn_last_4: "0000",
    },
    external_account: {
      object: "bank_account",
      country: "US",
      currency: "usd",
      account_number: "000123456789",
      routing_number: "110000000",
    },
    tos_acceptance: {
      date: Math.floor(Date.now() / 1000),
      ip: "127.0.0.1",
    },
    metadata: { seed: "stripe-subscriptions" },
  });

  await waitForConnectTransfers(stripe, account.id);
  return account.id;
}

async function waitForConnectTransfers(stripe, accountId) {
  for (let i = 0; i < 30; i++) {
    const acct = await stripe.accounts.retrieve(accountId);
    if (acct.capabilities && acct.capabilities.transfers === "active") {
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    `Connect account ${accountId} transfers capability did not activate in time`
  );
}

async function ensureConnectAccount(stripe, tenantData, profile) {
  const existing = (tenantData.stripeAccountId || "").toString().trim();
  if (existing) {
    try {
      const acct = await stripe.accounts.retrieve(existing);
      if (acct.capabilities && acct.capabilities.transfers === "active") {
        return existing;
      }
    } catch (_) {
      /* create fresh account below */
    }
  }
  return createTestConnectAccount(stripe, profile.email, profile.businessName);
}

async function createConnectFeeCharge(stripe, stripeAccountId, amountCents, paymentIndex) {
  const roundedAmount = Math.round(amountCents);
  const feeCents = platformFeeCents(roundedAmount);
  const pi = await stripe.paymentIntents.create({
    amount: roundedAmount,
    currency: "usd",
    payment_method: "pm_card_visa",
    payment_method_types: ["card"],
    confirm: true,
    application_fee_amount: feeCents,
    transfer_data: { destination: stripeAccountId },
    metadata: {
      seed: "stripe-subscriptions",
      paymentIndex: String(paymentIndex),
    },
  });
  return { paymentIntentId: pi.id, platformFeeCents: feeCents, amountCents: roundedAmount };
}

async function createBulkConnectPayments(stripe, stripeAccountId, args, tenantIndex) {
  let platformFeeTotalCents = 0;
  let connectVolumeCents = 0;
  let paymentCount = 0;

  for (let p = 0; p < args.paymentsPerTenant; p++) {
    const amount = paymentAmountCents(args, tenantIndex, p);
    const charge = await createConnectFeeCharge(stripe, stripeAccountId, amount, p + 1);
    platformFeeTotalCents += charge.platformFeeCents;
    connectVolumeCents += charge.amountCents;
    paymentCount += 1;
    if ((p + 1) % 10 === 0) await sleep(150);
  }

  return { platformFeeTotalCents, connectVolumeCents, paymentCount };
}

async function syncStripeIds(db, tenantId, billing, connect, memberMonths) {
  const patch = {
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (billing) {
    patch.stripeCustomerId = billing.customerId;
    patch.stripeSubscriptionId = billing.subscriptionId;
    patch.subscriptionStatus =
      billing.status === "trialing" ? "trialing" : "active";
    if (memberMonths > 0) {
      patch.subscriptionStartedAt = Timestamp.fromDate(memberStartDate(memberMonths));
    }
  }

  if (connect && connect.stripeAccountId) {
    patch.stripeAccountId = connect.stripeAccountId;
  }

  await db.collection("tenants").doc(tenantId).set(patch, { merge: true });
}

async function seedOne({
  db,
  projectId,
  accessToken,
  stripe,
  priceIds,
  args,
  index,
}) {
  const plan = args.mixPlans ? PLANS[(index - 1) % PLANS.length] : args.plan;
  const profile = seedProfile(index, plan);
  const priceId = priceIds[plan];

  if (args.dryRun) {
    return {
      index,
      email: profile.email,
      plan,
      dryRun: true,
      plannedPayments: args.withConnectFees ? args.paymentsPerTenant : 0,
    };
  }

  const auth = await createOrUpdateAuthUser(projectId, accessToken, {
    email: profile.email,
    password: args.password,
    displayName: profile.displayName,
  });

  const { tenantId, slug, reused } = await provisionFirestore(
    db,
    auth.uid,
    profile,
    args.memberMonths
  );

  const tenantSnap = await db.collection("tenants").doc(tenantId).get();
  const tenantData = tenantSnap.data() || {};
  const hasExistingSub =
    tenantData.stripeSubscriptionId && tenantData.subscriptionStatus === "active";

  let billing = null;
  let subSkipped = false;

  if (args.subscriptionsOnly) {
    if (hasExistingSub && !args.forceSubscriptions) {
      billing = await collectInvoicesForExistingSub(
        stripe,
        tenantData,
        profile,
        auth.uid
      );
      if (!billing) {
        billing = await ensureBackdatedSubscription(
          stripe,
          profile,
          priceId,
          auth.uid,
          args.memberMonths,
          false
        );
      } else {
        subSkipped = !!billing.reused;
      }
    } else {
      billing = await ensureBackdatedSubscription(
        stripe,
        profile,
        priceId,
        auth.uid,
        args.memberMonths,
        args.forceSubscriptions
      );
    }
  } else if (!args.paymentsOnly && hasExistingSub) {
    subSkipped = true;
    billing = {
      customerId: tenantData.stripeCustomerId,
      subscriptionId: tenantData.stripeSubscriptionId,
      status: tenantData.subscriptionStatus,
      subscriptionRevenueCents: 0,
      invoiceCount: 0,
      invoicesPaidThisRun: 0,
    };
  } else if (!args.paymentsOnly) {
    billing = await ensureBackdatedSubscription(
      stripe,
      profile,
      priceId,
      auth.uid,
      args.memberMonths,
      false
    );
  } else if (!tenantData.stripeCustomerId) {
    throw new Error(
      "payments-only requires an existing seeded tenant with stripeCustomerId"
    );
  } else {
    billing = {
      customerId: tenantData.stripeCustomerId,
      subscriptionId: tenantData.stripeSubscriptionId || null,
      status: tenantData.subscriptionStatus || "active",
      subscriptionRevenueCents: 0,
      invoiceCount: 0,
    };
  }

  let connect = null;
  const shouldRunPayments =
    args.withConnectFees &&
    args.paymentsPerTenant > 0 &&
    (!hasExistingSub || args.forcePayments || args.paymentsOnly);

  if (shouldRunPayments) {
    const stripeAccountId = await ensureConnectAccount(stripe, tenantData, profile);
    const bulk = await createBulkConnectPayments(
      stripe,
      stripeAccountId,
      args,
      index
    );
    connect = { stripeAccountId, ...bulk };
  } else if (hasExistingSub && subSkipped && args.withConnectFees && !args.forcePayments) {
    connect = { skippedPayments: true };
  }

  if (billing && billing.subscriptionId && (!subSkipped || args.subscriptionsOnly)) {
    await syncStripeIds(db, tenantId, billing, connect, args.memberMonths);
  } else if (connect && connect.stripeAccountId) {
    await syncStripeIds(db, tenantId, null, connect, args.memberMonths);
  }

  return {
    index,
    email: profile.email,
    plan: tenantData.subscriptionPlan || plan,
    tenantId,
    slug,
    authCreated: auth.created,
    reusedTenant: reused,
    subSkipped,
    stripeCustomerId: billing ? billing.customerId : null,
    stripeSubscriptionId: billing ? billing.subscriptionId : null,
    subscriptionStatus: billing ? billing.status : null,
    subscriptionRevenueCents: billing ? billing.subscriptionRevenueCents : 0,
    subscriptionInvoiceCount: billing ? billing.invoiceCount : 0,
    invoicesPaidThisRun: billing ? billing.invoicesPaidThisRun || 0 : 0,
    platformFeeTotalCents: connect ? connect.platformFeeTotalCents || 0 : 0,
    connectVolumeCents: connect ? connect.connectVolumeCents || 0 : 0,
    connectPaymentCount: connect ? connect.paymentCount || 0 : 0,
    paymentsSkipped: connect ? !!connect.skippedPayments : false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
Seed provider accounts with Stripe subscriptions + Connect customer payments.

  STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe-subscriptions.js --count=50 --with-connect-fees

Options:
  --count=50                    Number of accounts (default 50)
  --member-months=3             Backdate subscriptions N months (default 3, 0 = start today)
  --plan=solo                   solo | studio | shop (default solo)
  --mix-plans                   Rotate solo / studio / shop
  --with-connect-fees           Run Connect customer payments with 1% platform fee
  --payments-per-tenant=30      Connect charges per tenant (default 30 with --with-connect-fees)
  --connect-payment-cents=5000  Typical payment size in cents (default $50)
  --connect-payment-min-cents=  Min payment cents (default 60% of typical)
  --connect-payment-max-cents=  Max payment cents (default 140% of typical)
  --force-payments              Add Connect payments even if subscription already exists
  --payments-only               Skip subscription creation; only run Connect payments
  --subscriptions-only          Collect unpaid subscription invoices (finalize draft + pay open)
  --force-subscriptions         Create a new subscription even if one already exists
  --start-index=1               First index for stripe-seed-001@...
  --project=test-app-96812
  --password=...                DEMO_ACCOUNT_PASSWORD env or default
  --dry-run                     Print plan without calling Stripe/Firestore

Requires firebase login and STRIPE_SECRET_KEY (test mode).
`);
    process.exit(0);
  }

  const secretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!secretKey && !args.dryRun) {
    throw new Error("Set STRIPE_SECRET_KEY=sk_test_... (use Stripe test mode).");
  }
  if (secretKey && !secretKey.startsWith("sk_test_") && !args.dryRun) {
    console.warn("Warning: STRIPE_SECRET_KEY does not look like sk_test_ — use test mode for seeding.");
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || args.project;
  const priceIds = loadPriceIds();
  const { db, auth } = await createGoogleClients(projectId);
  const stripe = secretKey
    ? new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION })
    : null;

  console.log(`Project: ${projectId}`);
  console.log(
    `Seeding ${args.count} tenant(s) from index ${args.startIndex}` +
      (args.memberMonths > 0 ? ` (${args.memberMonths}-month member history)` : "") +
      (args.paymentsOnly ? " [payments only]" : "") +
      (args.subscriptionsOnly ? " [subscriptions only — collect invoices]" : "") +
      (args.withConnectFees
        ? ` + ${args.paymentsPerTenant} Connect payment(s)/tenant`
        : "") +
      (args.dryRun ? " [dry run]" : "")
  );
  console.log("");

  const results = [];
  let subscriptionRevenueCents = 0;
  let subscriptionInvoiceCount = 0;
  let invoicesPaidThisRun = 0;
  let platformFeeTotalCents = 0;
  let connectVolumeCents = 0;
  let connectPaymentCount = 0;

  for (let i = 0; i < args.count; i++) {
    const index = args.startIndex + i;
    process.stdout.write(`[${i + 1}/${args.count}] ${seedEmail(index)} ... `);
    try {
      const accessToken = await getAccessToken(auth);
      const result = await seedOne({
        db,
        projectId,
        accessToken,
        stripe,
        priceIds,
        args,
        index,
      });
      results.push(result);

      if (result.dryRun) {
        console.log(
          `dry run (${result.plannedPayments || 0} payment(s)/tenant planned)`
        );
      } else if (result.subSkipped && result.paymentsSkipped) {
        console.log("skip (existing sub; use --force-payments for more Connect charges)");
      } else {
        subscriptionRevenueCents += result.subscriptionRevenueCents || 0;
        subscriptionInvoiceCount += result.subscriptionInvoiceCount || 0;
        invoicesPaidThisRun += result.invoicesPaidThisRun || 0;
        platformFeeTotalCents += result.platformFeeTotalCents || 0;
        connectVolumeCents += result.connectVolumeCents || 0;
        connectPaymentCount += result.connectPaymentCount || 0;

        const parts = [];
        if (result.invoicesPaidThisRun) {
          parts.push(`${result.invoicesPaidThisRun} invoice(s) paid now`);
        }
        if (result.subSkipped && !result.invoicesPaidThisRun) parts.push("sub skipped");
        else if (result.subscriptionInvoiceCount) {
          parts.push(`${result.subscriptionInvoiceCount} paid invoice(s) total`);
        }
        if (result.connectPaymentCount) {
          parts.push(`${result.connectPaymentCount} payment(s)`);
        }
        console.log(parts.length ? `ok (${parts.join(", ")})` : "ok");
      }
    } catch (err) {
      console.log("FAILED");
      console.error(`  ${err.message || err}`);
      results.push({ index, email: seedEmail(index), error: err.message || String(err) });
    }
  }

  const ok = results.filter((r) => !r.error && !r.dryRun);
  const failed = results.filter((r) => r.error);
  const dryRunCount = results.filter((r) => r.dryRun).length;

  console.log("\n--- Summary ---\n");
  if (args.dryRun) {
    console.log(`Dry run: ${dryRunCount} tenant(s) planned`);
  } else {
    console.log(`Succeeded: ${ok.length}`);
    if (failed.length) console.log(`Failed:    ${failed.length}`);
  }

  if (!args.dryRun && ok.length) {
    if (subscriptionInvoiceCount || invoicesPaidThisRun) {
      console.log(
        `Subscription invoices: ${invoicesPaidThisRun} paid this run, ${subscriptionInvoiceCount} paid total (~$${(subscriptionRevenueCents / 100).toFixed(2)})`
      );
    }
    if (connectPaymentCount) {
      console.log(
        `Connect customer payments: ${connectPaymentCount} (~$${(connectVolumeCents / 100).toFixed(2)} volume)`
      );
      console.log(
        `Platform application fees (1%): $${(platformFeeTotalCents / 100).toFixed(2)}`
      );
    }
    console.log("\nStripe Dashboard (test mode):");
    console.log("  Billing → Subscriptions / Invoices (3-month history if backdated)");
    if (connectPaymentCount) {
      console.log("  Connect → Application fees + Payments");
    }
    console.log(`\nLogins: stripe-seed-XXX@getbookking.com`);
    console.log(`Password: ${args.password}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
