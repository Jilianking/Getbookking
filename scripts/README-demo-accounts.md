# Marketing demo accounts

Five solo showcase tenants for public sites (no visitor login).

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
| `northline-tattoo` | Northline Tattoo | Classic | https://northline-tattoo.getbookking.com |
| `coles-chair` | Cole's Chair | Blade | https://coles-chair.getbookking.com |
| `studio-amara` | Studio Amara | Studio 12 | https://studio-amara.getbookking.com |
| `stone-cut-barbers` | Stone Cut Barbers | Stonecut | https://stone-cut-barbers.getbookking.com |
| `gilded-palm` | Maison Lumière | Luxe | https://gilded-palm.getbookking.com |

Staging: `https://test-app-96812.web.app/{slug}`

Marketing picker: https://getbookking.com/demos.html (`?staging=1` for staging URLs).

## Owner logins (internal)

| Email | Slug |
|-------|------|
| demo-northline@getbookking.com | northline-tattoo |
| demo-coles-chair@getbookking.com | coles-chair |
| demo-studio-amara@getbookking.com | studio-amara |
| demo-stone-cut-barbers@getbookking.com | stone-cut-barbers |
| demo-gilded-palm@getbookking.com | gilded-palm |

Use owner accounts to upload photos and tweak copy in the app. Do not share passwords publicly.

## Colors & photos (seeded)

| Slug | Palette | Images |
|------|---------|--------|
| northline-tattoo | `warm-coral` (custom) | Custom hero + 8-gallery (see `scripts/assets/northline-tattoo/`) |
| coles-chair | `copper-ledger` | Custom hero + 12-gallery (see `scripts/assets/coles-chair/`) |
| studio-amara | `rose-quartz` (custom) | User nail set: hero + 6-gallery + philosophy + book CTA (`scripts/assets/studio-amara/`) |
| stone-cut-barbers | `barber-chocolate` (custom) | Custom hero + 9-gallery (see `scripts/assets/stone-cut-barbers/`) |
| gilded-palm | `terracotta-clay` (custom) | Custom hero + 10-gallery + 5 shop products (see `scripts/assets/gilded-palm/`) |

Re-run `node scripts/seed-demo-accounts.js` to refresh. Replace with your own uploads in Website Design anytime.

## Marketing live preview

`web/marketing/index.html` embeds `{slug}.getbookking.com/home?bk_embed=1` in the templates section. Deploy **both** hosting targets after changes:

```bash
firebase deploy --only hosting:booking,hosting:marketing
```

`firebase.json` sets `frame-ancestors` on booking sites so getbookking.com can iframe them.
