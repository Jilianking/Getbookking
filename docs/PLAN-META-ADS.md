# Plan: Meta ads for a business

Status: **connection and the Ads page are built.** The server lives in `functions/metaAds.js`. iPhone and the web shop each have an Ads screen under Business, after Payments. Insights is unchanged. A booking sent to Meta as a Schedule conversion is not built yet.

Instagram DMs stay as they are. This is a second connect on the same Meta app
(`1548817268385887`). Instagram login uses a different app id (`1646058753784138`
in `functions/instagram.js`) and cannot read an ad account.

## Why

A shop already runs ads in Meta Ads Manager. Get Bookking should show that spend
next to bookings, and tell Meta when a booking is confirmed, so those campaigns
can optimize for a booking. This pass does not build an ads manager inside the app.

Get Bookking’s own install ads are already covered by `Test/MetaTracking.swift`
and the marketing-site pixel in `web/marketing/assets/cookie-consent.js`. Leave
those alone.

## What this pass includes

- Owner on a paid plan connects one Meta ad account.
- Insights shows spend, impressions, clicks, and results for the range already
  selected on that screen.
- When a booking is confirmed, the server sends Meta a `Schedule` conversion.
  No pixel on the shop’s website. The privacy policy can stay as it is: Meta
  Pixel only on Get Bookking marketing pages.

## What this pass leaves out

- Creating, editing, or pausing campaigns (`ads_management`, the “Create & manage
  ads” use case).
- Lead-form ads into Requests (“Capture & manage ad leads”).
- App-install campaigns for Get Bookking (“Create & manage app ads”).
- A personal ads connection for teammates. Ad accounts belong to the business.
  Studio and Shop personal Instagram stays a messaging feature only.

## What you do before any code is tested

On the Meta app Use cases screen:

1. Add **Measure ad performance data with Marketing API**.
2. In Customize, keep `ads_read` and `business_management`.
3. Leave off: Create & manage ads, Capture & manage ad leads, Create & manage
   app ads, and the ads MCP server.
4. Confirm **Facebook Login** is on the app. Ads use Facebook Login.
5. Do not submit App Review yet. In Development, only Admins, Developers, and
   Testers on this app can connect. That is enough to build.
6. Start business verification if it is not already approved. Meta requires it
   before Advanced Access. Other shops cannot connect until that access is
   approved and the app is Live.

No new secret. Ads reuse `META_APP_SECRET` (the Facebook app secret).
`META_INSTAGRAM_APP_SECRET` stays for DMs.

After the functions are deployed, add this under Facebook Login → Valid OAuth
Redirect URIs:

`https://us-central1-test-app-96812.cloudfunctions.net/metaAdsOAuthCallback`

## What to build

Follow `functions/instagram.js`: signed OAuth state, long-lived token, paid
gate via `sms.tenantHasPaidSubscription`, owner-only. Graph host is
`https://graph.facebook.com` (Instagram DMs use `graph.instagram.com`).

### Server — `functions/metaAds.js`

Export from `functions/index.js` next to the Instagram exports:

| Function | Job |
|---|---|
| `startMetaAdsConnect` | Owner + paid. Returns the Facebook Login URL. |
| `metaAdsOAuthCallback` | Exchanges the code, stores the long-lived token, lists ad accounts. |
| `disconnectMetaAds` | Owner. Clears the connection. |
| `getMetaAdsInsights` | Owner + paid. Spend, impressions, clicks, results for a date range. |
| `selectMetaAdAccount` | Owner. Picks one account when Facebook returns several. |

Token refresh uses the same long-lived exchange pattern as Instagram. Scopes:
`ads_read,business_management`.

Booking conversions: from `confirmBookingAfterDepositPaid` in `functions/index.js`
(and the charter checkout path that also marks a booking confirmed), send one
server-side Conversions API `Schedule` event. Deduplicate on booking id. Skip
when ads are not connected, or when the booking has no email and no phone to
hash. Hash email and phone before the request. Do not log them.

### Where the token lives

The Instagram token sits on the tenant doc. The signed-in shop can read that
doc (`firestore.rules` allows tenant read). An ads token can read spend, so it
does not go on the tenant doc.

- Token, expiry: `tenants/{id}/private/metaAds`. Rules: `allow read, write: if false`.
  Cloud Functions use the Admin SDK and bypass rules.
- What the app is allowed to see, on the tenant doc, server-write only (same
  lists as `igStatus` / `igToken` in `firestore.rules`): `metaAdsStatus`,
  `metaAdAccountId`, `metaAdAccountName`, `metaAdsCurrency`, `metaAdsConnectedAt`,
  `metaAdsProvisionError`. Status values match Instagram: `off`, `connecting`,
  `connected`, `failed`, `expired`.

### App

- iOS Insights (`Test/InsightsView.swift`): a card under the existing range
  picker. Connect, disconnect, and the four numbers. Owner only, and only when
  `canSeeMoney` is true. Paid-plan copy matches the Instagram gate in
  `Test/TeamClientMessagingSettingsView.swift`.
- Web Insights (`web/marketing/assets/app-insights.js`): the same card.
- Several ad accounts: a short picker before the card fills in. One account is
  remembered.

Demo accounts do not call Meta. The card shows the disconnected state and the
buttons do nothing, same idea as other demo gates.

## What you do after Phase 1 is deployed

1. Paste the redirect URI above into Facebook Login.
2. Connect a real ad account while you are an Admin or Tester on the Meta app.
3. Compare Insights spend and clicks with Ads Manager for the same dates.
4. Confirm a test booking and look for the `Schedule` event in Events Manager.
5. When that matches, submit App Review for Advanced Access on `ads_read` and
   `business_management`. The review text and screencast script can be drafted
   here. You record the screencast and submit it.
6. After approval, switch the Meta app to Live. Until then, only people with a
   role on the app can connect.

## Later

Creating campaigns needs the “Create & manage ads” use case, `ads_management`,
and a second App Review. Lead-form ads need “Capture & manage ad leads” and a
webhook, closer to the Instagram inbox than to Insights.
