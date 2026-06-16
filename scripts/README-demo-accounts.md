# Marketing demo accounts

Four solo showcase tenants for public sites (no visitor login).

## Seed / update

```bash
cd /Users/jilianking/Projects/Test
node scripts/seed-demo-accounts.js
node scripts/seed-demo-accounts.js --only=coles-chair
```

Requires `firebase login` or `GOOGLE_APPLICATION_CREDENTIALS`.

Password: `DEMO_ACCOUNT_PASSWORD` env var, or default `BookkingDemo2026!`.

## Sites

| Slug | Business | Theme | Public URL |
|------|----------|-------|------------|
| `coles-chair` | Cole's Chair | Blade | https://coles-chair.getbookking.com |
| `studio-amara` | Studio Amara | Studio 12 | https://studio-amara.getbookking.com |
| `northline-tattoo` | Northline Tattoo | Stonecut | https://northline-tattoo.getbookking.com |
| `gilded-palm` | Gilded Palm | Luxe | https://gilded-palm.getbookking.com |

Staging: `https://test-app-96812.web.app/{slug}`

Marketing picker: https://getbookking.com/demos.html (`?staging=1` for staging URLs).

## Owner logins (internal)

| Email | Slug |
|-------|------|
| demo-coles-chair@getbookking.com | coles-chair |
| demo-studio-amara@getbookking.com | studio-amara |
| demo-northline@getbookking.com | northline-tattoo |
| demo-gilded-palm@getbookking.com | gilded-palm |

Use owner accounts to upload photos and tweak copy in the app. Do not share passwords publicly.

## Colors & photos (seeded)

| Slug | Palette | Images |
|------|---------|--------|
| coles-chair | `copper-ledger` | Custom hero + 12-gallery (see `scripts/assets/coles-chair/`) |
| studio-amara | `rose-quartz` | Unsplash hero + featured + gallery |
| northline-tattoo | `berry-noir` | Unsplash hero + featured + gallery |
| gilded-palm | `terracotta-clay` | Unsplash hero + featured + gallery |

Re-run `node scripts/seed-demo-accounts.js` to refresh. Replace with your own uploads in Website Design anytime.

## Marketing live preview

`web/marketing/index.html` embeds `{slug}.getbookking.com/home?bk_embed=1` in the templates section. Deploy **both** hosting targets after changes:

```bash
firebase deploy --only hosting:booking,hosting:marketing
```

`firebase.json` sets `frame-ancestors` on booking sites so getbookking.com can iframe them.
