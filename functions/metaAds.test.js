const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("./metaAdsLib");

const sales = {
  name: "Spring bookings",
  objective: "sales",
  advantageCampaignBudget: true,
  budgetType: "daily",
  budget: 20,
  currency: "USD",
  bidStrategy: "highest_volume",
  status: "paused",
};

test("budgets use the currency minor unit", () => {
  assert.equal(lib.minorUnits(20, "USD"), 2000);
  assert.equal(lib.minorUnits(20, "jpy"), 20);
  assert.throws(() => lib.minorUnits(0, "USD"), /greater than zero/);
});

test("campaign budget stays on the campaign", () => {
  const body = lib.buildCampaignBody(sales);
  assert.equal(body.objective, "OUTCOME_SALES");
  assert.equal(body.daily_budget, 2000);
  assert.equal(body.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
  assert.deepEqual(body.special_ad_categories, ["NONE"]);
  assert.equal(body.status, "PAUSED");
  assert.equal(body.is_adset_budget_sharing_enabled, undefined);
});

test("ad set budgets turn sharing off on the campaign", () => {
  const body = lib.buildCampaignBody(Object.assign({}, sales, { advantageCampaignBudget: false }));
  assert.equal(body.daily_budget, undefined);
  assert.equal(body.is_adset_budget_sharing_enabled, false);
});

test("a lifetime budget needs an end date", () => {
  assert.throws(
    () => lib.buildCampaignBody(Object.assign({}, sales, { budgetType: "lifetime" })),
    /end date/
  );
});

test("sales ad set optimizes for Schedule and keeps Advantage+ audience", () => {
  const body = lib.buildAdSetBody(
    {
      name: "People near the shop",
      campaignId: "99",
      objective: "sales",
      pixelId: "pixel1",
      latitude: 41.82,
      longitude: -71.41,
      radiusMiles: 15,
      ageMin: 18,
      ageMax: 54,
      advantageAudience: true,
      advantagePlacements: true,
      advantageCampaignBudget: true,
      status: "active",
    },
    { objective: "OUTCOME_SALES" }
  );
  assert.equal(body.optimization_goal, "OFFSITE_CONVERSIONS");
  assert.equal(body.destination_type, "WEBSITE");
  assert.deepEqual(body.promoted_object, { pixel_id: "pixel1", custom_event_type: "SCHEDULE" });
  assert.equal(body.status, "ACTIVE");
  assert.equal(body.targeting.age_max, undefined);
  assert.deepEqual(body.targeting.age_range, [18, 54]);
  assert.equal(body.targeting.targeting_automation.advantage_audience, 1);
  assert.equal(body.targeting.publisher_platforms, undefined);
  assert.equal(body.targeting.geo_locations.custom_locations[0].radius, 15);
  assert.equal(body.daily_budget, undefined);
});

test("sales without a dataset is rejected", () => {
  assert.throws(
    () =>
      lib.buildAdSetBody({
        name: "People near the shop",
        campaignId: "99",
        objective: "sales",
        countries: ["US"],
      }),
    /dataset/
  );
});

test("manual placements and ad set budget are sent through", () => {
  const body = lib.buildAdSetBody({
    name: "Manual",
    campaignId: "99",
    objective: "traffic",
    performanceGoal: "link_clicks",
    countries: ["US"],
    advantageCampaignBudget: false,
    budget: 15,
    currency: "USD",
    advantagePlacements: false,
    advantageAudience: false,
    ageMin: 25,
    ageMax: 44,
  });
  assert.equal(body.optimization_goal, "LINK_CLICKS");
  assert.equal(body.daily_budget, 1500);
  assert.deepEqual(body.targeting.publisher_platforms, ["facebook", "instagram"]);
  assert.equal(body.targeting.age_min, 25);
  assert.equal(body.targeting.age_max, 44);
  assert.equal(body.targeting.targeting_automation.advantage_audience, 0);
});

test("special ad categories keep a 15 mile radius and turn Advantage+ audience off", () => {
  const body = lib.buildAdSetBody({
    name: "Housing",
    campaignId: "99",
    objective: "traffic",
    specialAdCategory: "housing",
    latitude: 41.8,
    longitude: -71.4,
    radiusMiles: 5,
    countries: ["US"],
    advantageAudience: true,
  });
  assert.equal(body.targeting.targeting_automation.advantage_audience, 0);
  assert.equal(body.targeting.geo_locations.custom_locations[0].radius, 15);
});

test("ad creative uses Book now and opts out of product showcase", () => {
  const body = lib.buildCreativeBody({
    name: "Small piece",
    pageId: "111",
    instagramUserId: "222",
    link: "https://blueline.com/book/small-piece",
    message: "Now booking small pieces.",
    headline: "Book a small piece",
    imageHash: "abc",
    callToAction: "book now",
  });
  assert.equal(body.object_story_spec.page_id, "111");
  assert.equal(body.object_story_spec.instagram_user_id, "222");
  assert.equal(body.object_story_spec.link_data.call_to_action.type, "BOOK_NOW");
  assert.equal(body.object_story_spec.link_data.image_hash, "abc");
  assert.equal(
    body.degrees_of_freedom_spec.creative_features_spec.product_extensions.enroll_status,
    "OPT_OUT"
  );
});

test("an existing post becomes an object story id", () => {
  const body = lib.buildCreativeBody({ pageId: "111", postId: "999", name: "Post" });
  assert.equal(body.object_story_id, "111_999");
});

test("insights count booking results and not clicks", () => {
  const summary = lib.insightsSummary({
    spend: "420.00",
    impressions: "38400",
    clicks: "612",
    actions: [
      { action_type: "link_click", value: "612" },
      { action_type: "offsite_conversion.fb_pixel_schedule", value: "27" },
    ],
  });
  assert.equal(summary.results, 27);
  assert.equal(summary.spend, 420);
  assert.equal(summary.clicks, 612);
  assert.equal(summary.costPerResult, 15.56);
});

test("signed connect state rejects tampering and expiry", () => {
  const secret = "test-secret";
  const token = lib.signState({ tenantId: "t1", uid: "u1", exp: Date.now() + 1000 }, secret);
  assert.equal(lib.readState(token, secret).tenantId, "t1");
  assert.equal(lib.readState(`${token}x`, secret), null);
  const expired = lib.signState({ tenantId: "t1", uid: "u1", exp: Date.now() - 1000 }, secret);
  assert.equal(lib.readState(expired, secret), null);
});

test("ad account ids are normalized", () => {
  assert.equal(lib.actPath("act_1842"), "act_1842");
  assert.equal(lib.actPath("1842"), "act_1842");
  assert.throws(() => lib.actPath("blue"), /ad account/);
  assert.throws(() => lib.dateOnly("11/22/2026"), /YYYY-MM-DD/);
});
