/**
 * Pure Meta Marketing API shapes (Graph v27). No Firestore and no network.
 * Campaign, ad set, and ad fields follow Ads Manager's order.
 */

const crypto = require("crypto");

const GRAPH_VERSION = "v27.0";
const FB_APP_ID = "1548817268385887";
const SCOPES = [
  "ads_read",
  "ads_management",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_ads",
].join(",");

/** Currencies where 1 major unit is not 100 minor units. Meta budgets use minor units. */
const CURRENCY_OFFSET = {
  BIF: 1, CLP: 1, DJF: 1, GNF: 1, JPY: 1, KMF: 1, KRW: 1, MGA: 1,
  PYG: 1, RWF: 1, VND: 1, VUV: 1, XAF: 1, XOF: 1, XPF: 1,
  BHD: 1000, IQD: 1000, JOD: 1000, KWD: 1000, LYD: 1000, OMR: 1000, TND: 1000,
};

const OBJECTIVES = {
  awareness: "OUTCOME_AWARENESS",
  traffic: "OUTCOME_TRAFFIC",
  engagement: "OUTCOME_ENGAGEMENT",
  leads: "OUTCOME_LEADS",
  app: "OUTCOME_APP_PROMOTION",
  sales: "OUTCOME_SALES",
};

const BID_STRATEGIES = {
  highest_volume: "LOWEST_COST_WITHOUT_CAP",
  cost_per_result: "COST_CAP",
  bid_cap: "LOWEST_COST_WITH_BID_CAP",
};

const CTA = {
  book_now: "BOOK_NOW",
  learn_more: "LEARN_MORE",
  sign_up: "SIGN_UP",
  shop_now: "SHOP_NOW",
  send_message: "MESSAGE_PAGE",
  contact_us: "CONTACT_US",
  get_quote: "GET_QUOTE",
};

const SPECIAL = {
  none: "NONE",
  housing: "HOUSING",
  employment: "EMPLOYMENT",
  credit: "CREDIT",
  financial: "FINANCIAL_PRODUCTS_SERVICES",
};

const RESULT_ACTION_TYPES = [
  "offsite_conversion.fb_pixel_schedule",
  "schedule",
  "offsite_conversion.fb_pixel_purchase",
  "offsite_conversion.fb_pixel_lead",
  "lead",
  "onsite_conversion.lead_grouped",
  "onsite_conversion.messaging_conversation_started_7d",
];

function invalid(message) {
  const err = new Error(message);
  err.code = "invalid";
  return err;
}

function clip(value, max) {
  return (value || "").toString().trim().slice(0, max);
}

function currencyOffset(currency) {
  const code = (currency || "USD").toString().trim().toUpperCase();
  return CURRENCY_OFFSET[code] || 100;
}

function minorUnits(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw invalid("Enter a budget greater than zero.");
  }
  return Math.round(n * currencyOffset(currency));
}

function objectiveCode(input) {
  const raw = (input || "sales").toString().trim();
  const lower = raw.toLowerCase();
  if (OBJECTIVES[lower]) return OBJECTIVES[lower];
  const upper = raw.toUpperCase();
  if (Object.values(OBJECTIVES).includes(upper)) return upper;
  throw invalid("Choose a campaign objective.");
}

function bidStrategyCode(input) {
  const raw = (input || "highest_volume").toString().trim();
  const lower = raw.toLowerCase();
  if (BID_STRATEGIES[lower]) return BID_STRATEGIES[lower];
  const upper = raw.toUpperCase();
  if (Object.values(BID_STRATEGIES).includes(upper)) return upper;
  throw invalid("Choose a bid strategy.");
}

function ctaType(input) {
  const raw = (input || "book_now").toString().trim();
  const lower = raw.toLowerCase().replace(/\s+/g, "_");
  if (CTA[lower]) return CTA[lower];
  const upper = raw.toUpperCase();
  if (Object.values(CTA).includes(upper)) return upper;
  throw invalid("Choose a call to action.");
}

function specialAdCategories(input) {
  const raw = (input || "none").toString().trim().toLowerCase();
  const code = SPECIAL[raw] || (raw.toUpperCase() === "NONE" ? "NONE" : "");
  if (!code && raw) {
    const upper = (input || "").toString().trim().toUpperCase();
    if (Object.values(SPECIAL).includes(upper)) return [upper];
  }
  if (!code) throw invalid("Choose a special ad category, or None.");
  return [code];
}

function statusCode(input) {
  return (input || "").toString().trim().toLowerCase() === "active" ? "ACTIVE" : "PAUSED";
}

function httpsUrl(value, label) {
  const url = (value || "").toString().trim();
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw invalid(`${label} must be a full https link.`);
  }
  if (parsed.protocol !== "https:") throw invalid(`${label} must be a full https link.`);
  return url;
}

function deliveryFor(objective, input) {
  const loc = (input.conversionLocation || "website").toString().trim().toLowerCase();
  const goal = (input.performanceGoal || "").toString().trim().toLowerCase();
  if (objective === "OUTCOME_AWARENESS") {
    return { optimization_goal: "REACH", needsPixel: false };
  }
  if (objective === "OUTCOME_TRAFFIC") {
    const landing = goal === "landing_page_views" || goal === "landing";
    return {
      destination_type: "WEBSITE",
      optimization_goal: landing ? "LANDING_PAGE_VIEWS" : "LINK_CLICKS",
      needsPixel: landing,
      event: "CONTENT_VIEW",
    };
  }
  if (objective === "OUTCOME_APP_PROMOTION") {
    return { optimization_goal: "APP_INSTALLS", needsApp: true };
  }
  if (loc === "messenger" || loc === "instagram" || goal === "conversations") {
    return {
      destination_type: loc === "instagram" ? "INSTAGRAM_DIRECT" : "MESSENGER",
      optimization_goal: "CONVERSATIONS",
      needsPage: true,
    };
  }
  if (objective === "OUTCOME_LEADS") {
    return {
      destination_type: "WEBSITE",
      optimization_goal: "OFFSITE_CONVERSIONS",
      needsPixel: true,
      event: "LEAD",
    };
  }
  return {
    destination_type: "WEBSITE",
    optimization_goal: "OFFSITE_CONVERSIONS",
    needsPixel: true,
    event: (input.customEventType || "SCHEDULE").toString().trim().toUpperCase() || "SCHEDULE",
  };
}

function buildCampaignBody(input) {
  const name = clip(input && input.name, 400);
  if (!name) throw invalid("Name the campaign.");
  const objective = objectiveCode(input.objective);
  const advantage = input.advantageCampaignBudget !== false;
  const body = {
    name,
    objective,
    status: statusCode(input.status),
    special_ad_categories: specialAdCategories(input.specialAdCategory),
  };
  const strategy = bidStrategyCode(input.bidStrategy);
  if (advantage) {
    const field = (input.budgetType || "daily").toString().toLowerCase() === "lifetime"
      ? "lifetime_budget"
      : "daily_budget";
    if (field === "lifetime_budget" && !input.endTime) {
      throw invalid("A lifetime budget needs an end date.");
    }
    body[field] = minorUnits(input.budget, input.currency);
    body.bid_strategy = strategy;
  } else {
    body.is_adset_budget_sharing_enabled = false;
  }
  return body;
}

function locationTargeting(input, specialCode) {
  const lat = Number(input.latitude);
  const lng = Number(input.longitude);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng);
  if (hasPoint) {
    let radius = Number(input.radiusMiles);
    if (!Number.isFinite(radius) || radius <= 0) radius = 15;
    const minRadius = specialCode && specialCode !== "NONE" ? 15 : 1;
    radius = Math.min(50, Math.max(minRadius, radius));
    return {
      custom_locations: [
        {
          latitude: lat,
          longitude: lng,
          radius: Math.round(radius),
          distance_unit: "mile",
        },
      ],
    };
  }
  const countries = Array.isArray(input.countries)
    ? input.countries.map((c) => (c || "").toString().trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c))
    : [];
  if (!countries.length) throw invalid("Add a location for this ad set.");
  return { countries };
}

function buildTargeting(input, specialCategories) {
  const special = (specialCategories && specialCategories[0]) || "NONE";
  const advantage = special === "NONE" && input.advantageAudience !== false;
  const ageMinReq = Math.min(65, Math.max(18, Math.round(Number(input.ageMin) || 18)));
  const ageMaxReq = Math.min(65, Math.max(ageMinReq, Math.round(Number(input.ageMax) || 65)));
  const targeting = {
    geo_locations: locationTargeting(input, special),
    targeting_automation: { advantage_audience: advantage ? 1 : 0 },
  };
  if (advantage) {
    targeting.age_min = Math.min(ageMinReq, 25);
    targeting.age_range = [ageMinReq, ageMaxReq];
  } else {
    targeting.age_min = ageMinReq;
    targeting.age_max = ageMaxReq;
  }
  if (input.advantagePlacements === false) {
    const facebook = (input.placements && input.placements.facebook) || ["feed", "story"];
    const instagram = (input.placements && input.placements.instagram) || ["stream", "story", "reels"];
    targeting.publisher_platforms = ["facebook", "instagram"];
    targeting.facebook_positions = facebook;
    targeting.instagram_positions = instagram;
  }
  return targeting;
}

function buildAdSetBody(input, campaign) {
  const name = clip(input && input.name, 400);
  if (!name) throw invalid("Name the ad set.");
  const campaignId = (input.campaignId || "").toString().trim();
  if (!campaignId) throw invalid("The ad set needs a campaign.");
  const objective = objectiveCode(input.objective || (campaign && campaign.objective));
  const plan = deliveryFor(objective, input);
  const advantageBudget = input.advantageCampaignBudget !== false;
  const body = {
    name,
    campaign_id: campaignId,
    status: statusCode(input.status),
    billing_event: "IMPRESSIONS",
    optimization_goal: plan.optimization_goal,
    targeting: buildTargeting(input, specialAdCategories(input.specialAdCategory)),
  };
  if (plan.destination_type) body.destination_type = plan.destination_type;
  if (plan.needsPixel) {
    const pixelId = (input.pixelId || "").toString().trim();
    if (!pixelId) throw invalid("Choose a dataset before publishing this campaign.");
    body.promoted_object = {
      pixel_id: pixelId,
      custom_event_type: plan.event || "SCHEDULE",
    };
  } else if (plan.needsPage) {
    const pageId = (input.pageId || "").toString().trim();
    if (!pageId) throw invalid("Choose a Facebook Page for message ads.");
    body.promoted_object = { page_id: pageId };
  } else if (plan.needsApp) {
    const applicationId = (input.applicationId || "").toString().trim();
    const storeUrl = httpsUrl(input.storeUrl, "The store link");
    if (!applicationId) throw invalid("App promotion needs an app id and a store link.");
    body.promoted_object = { application_id: applicationId, object_store_url: storeUrl };
  }
  const strategy = bidStrategyCode(input.bidStrategy);
  if (!advantageBudget) {
    const field = (input.budgetType || "daily").toString().toLowerCase() === "lifetime"
      ? "lifetime_budget"
      : "daily_budget";
    if (field === "lifetime_budget" && !input.endTime) {
      throw invalid("A lifetime budget needs an end date.");
    }
    body[field] = minorUnits(input.budget, input.currency);
    body.bid_strategy = strategy;
  } else if ((input.budgetType || "").toString().toLowerCase() === "lifetime" && !input.endTime) {
    throw invalid("A lifetime budget needs an end date.");
  }
  if (strategy !== "LOWEST_COST_WITHOUT_CAP") {
    body.bid_amount = minorUnits(input.bidAmount, input.currency);
  }
  if (input.startTime) body.start_time = input.startTime;
  if (input.endTime) body.end_time = input.endTime;
  return body;
}

function buildCreativeBody(input) {
  const pageId = (input.pageId || "").toString().trim();
  if (!pageId) throw invalid("Choose a Facebook Page.");
  const name = clip(input.name, 400) || "Ad";
  const postId = (input.postId || "").toString().trim();
  if (postId) {
    const storyId = postId.includes("_") ? postId : `${pageId}_${postId}`;
    return { name, object_story_id: storyId };
  }
  const link = httpsUrl(input.link, "The website URL");
  const message = clip(input.message, 2200);
  const headline = clip(input.headline, 255);
  if (!message) throw invalid("Write the primary text.");
  if (!headline) throw invalid("Write a headline.");
  const imageHash = (input.imageHash || "").toString().trim();
  if (!imageHash) throw invalid("Add a photo.");
  const linkData = {
    link,
    message,
    name: headline,
    image_hash: imageHash,
    call_to_action: { type: ctaType(input.callToAction), value: { link } },
  };
  const description = clip(input.description, 255);
  if (description) linkData.description = description;
  const spec = { page_id: pageId, link_data: linkData };
  const instagramUserId = (input.instagramUserId || "").toString().trim();
  if (instagramUserId) spec.instagram_user_id = instagramUserId;
  const body = {
    name,
    object_story_spec: spec,
    degrees_of_freedom_spec: {
      creative_features_spec: {
        product_extensions: { enroll_status: "OPT_OUT" },
      },
    },
  };
  if (input.advantageCreative === false) {
    const features = body.degrees_of_freedom_spec.creative_features_spec;
    features.image_touchups = { enroll_status: "OPT_OUT" };
    features.text_optimizations = { enroll_status: "OPT_OUT" };
    features.image_templates = { enroll_status: "OPT_OUT" };
  }
  return body;
}

function buildAdBody(input) {
  const name = clip(input.name, 400) || "Ad";
  const adsetId = (input.adSetId || "").toString().trim();
  const creativeId = (input.creativeId || "").toString().trim();
  if (!adsetId || !creativeId) throw invalid("The ad needs an ad set and a creative.");
  return {
    name,
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: statusCode(input.status),
  };
}

function insightsSummary(row) {
  const source = row && typeof row === "object" ? row : {};
  const actions = Array.isArray(source.actions) ? source.actions : [];
  let results = 0;
  RESULT_ACTION_TYPES.forEach((type) => {
    const hit = actions.find((item) => item && item.action_type === type);
    if (hit) results += Number(hit.value) || 0;
  });
  const spend = Number(source.spend) || 0;
  return {
    spend,
    impressions: Number(source.impressions) || 0,
    clicks: Number(source.clicks) || 0,
    results,
    costPerResult: results > 0 ? Math.round((spend / results) * 100) / 100 : null,
  };
}

function actPath(accountId) {
  const raw = (accountId || "").toString().trim().replace(/^act_/, "");
  if (!/^\d+$/.test(raw)) throw invalid("Choose an ad account.");
  return `act_${raw}`;
}

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readState(token, secret) {
  const raw = (token || "").toString().trim();
  const dot = raw.indexOf(".");
  if (dot <= 0 || !secret) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!timingSafeEqualString(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (!payload.exp || Number(payload.exp) < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function dateOnly(value) {
  const raw = (value || "").toString().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw invalid("Use dates as YYYY-MM-DD.");
  return raw;
}

module.exports = {
  GRAPH_VERSION,
  FB_APP_ID,
  SCOPES,
  RESULT_ACTION_TYPES,
  minorUnits,
  currencyOffset,
  objectiveCode,
  bidStrategyCode,
  ctaType,
  specialAdCategories,
  buildCampaignBody,
  buildAdSetBody,
  buildCreativeBody,
  buildAdBody,
  insightsSummary,
  actPath,
  signState,
  readState,
  dateOnly,
  httpsUrl,
  invalid,
};
