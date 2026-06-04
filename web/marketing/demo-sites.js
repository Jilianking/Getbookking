/** Shared marketing demo tenant URLs (see scripts/seed-demo-accounts.js). */
(function (global) {
  var BOOKING_HOST = "getbookking.com";
  var STAGING_ORIGIN = "https://test-app-96812.web.app";

  var DEMOS = [
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
      id: "stylist",
      slug: "studio-amara",
      name: "Studio Amara",
      industry: "Hair salon",
      theme: "Studio 12",
      tagline: "Color that respects your hair.",
      location: "Charleston, SC",
    },
    {
      id: "tattoo",
      slug: "northline-tattoo",
      name: "Northline Tattoo",
      industry: "Tattoo studio",
      theme: "Stonecut",
      tagline: "Permanent, on purpose.",
      location: "Portland, OR",
    },
    {
      id: "nail",
      slug: "gilded-palm",
      name: "Gilded Palm",
      industry: "Nail salon",
      theme: "Luxe",
      tagline: "Quiet luxury for your hands.",
      location: "Coral Gables, FL",
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
