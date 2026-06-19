/** Shared marketing demo tenant URLs (see scripts/seed-demo-accounts.js). */
(function (global) {
  var BOOKING_HOST = "getbookking.com";
  var STAGING_ORIGIN = "https://test-app-96812.web.app";

  var DEMOS = [
    {
      id: "tattoo",
      slug: "northline-tattoo",
      name: "Northline Tattoo",
      industry: "Tattoo studio",
      theme: "Classic",
      tagline: "Permanent, on purpose.",
      location: "Portland, OR",
    },
    {
      id: "barber",
      slug: "coles-chair",
      name: "Cole's Chair",
      industry: "Barber",
      theme: "Blade",
      tagline: "Sharp lines. Clean chair.",
      location: "Austin, TX",
    },
    {
      id: "nail",
      slug: "studio-amara",
      name: "Studio Amara",
      industry: "Nail salon",
      theme: "Studio 12",
      tagline: "Clean, polished, and done right.",
      location: "Charleston, SC",
    },
    {
      id: "barber-stonecut",
      slug: "stone-cut-barbers",
      name: "Stone Cut Barbers",
      industry: "Barber",
      theme: "Stonecut",
      tagline: "Sharp lines. Warm welcome.",
      location: "Nashville, TN",
    },
    {
      id: "hair-luxe",
      slug: "gilded-palm",
      name: "Maison Lumière",
      industry: "Hair salon",
      theme: "Luxe",
      tagline: "Elevated hair, tailored to you.",
      location: "Coral Gables, FL",
    },
    {
      id: "gym",
      slug: "iron-district-gym",
      name: "Jordan Reyes",
      industry: "Personal trainer",
      theme: "Stonecut",
      tagline: "Strength coaching for real life.",
      location: "Denver, CO",
    },
  ];

  function demoSiteUrl(slug, useStaging, embed) {
    var base;
    if (useStaging) base = STAGING_ORIGIN + "/" + slug + "/home";
    else base = "https://" + slug + "." + BOOKING_HOST + "/home";
    if (embed) base += (base.indexOf("?") >= 0 ? "&" : "?") + "bk_embed=1";
    return base;
  }

  function findDemo(idOrSlug) {
    return DEMOS.find(function (d) {
      return d.id === idOrSlug || d.slug === idOrSlug;
    });
  }

  global.BookkingDemoSites = {
    demos: DEMOS,
    bookingHost: BOOKING_HOST,
    stagingOrigin: STAGING_ORIGIN,
    url: demoSiteUrl,
    find: findDemo,
  };
})(typeof window !== "undefined" ? window : globalThis);
