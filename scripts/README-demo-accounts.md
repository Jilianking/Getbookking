# Marketing demo accounts

Five solo showcase tenants for public sites (no visitor login).

## Seed / update

```bash
cd /Users/jilianking/Projects/Test
node scripts/seed-demo-accounts.js
node scripts/seed-demo-accounts.js --only=iron-district-gym
```

### Demo activity (bookings, clients, SMS, fake payments)

After tenants exist, seed 60-day marketing data (real names, industry services, showcase payments):

```bash
node scripts/seed-demo-activity.js
node scripts/seed-demo-activity.js --only=northline-tattoo
node scripts/seed-demo-activity.js --no-replace   # append without deleting prior demo-seed rows
```

Deploy payment shim (once per project):

```bash
firebase deploy --only functions:getConnectAccountStatus,functions:getConnectBalance,functions:getConnectBalanceTransactions
```

Sign in as a demo owner → Dashboard, Requests, Messages, Payments, Insights.

Requires `firebase login` or `GOOGLE_APPLICATION_CREDENTIALS`.

Password: `DEMO_ACCOUNT_PASSWORD` env var, or default `BookkingDemo2026!`.

## Sites

| Slug | Business | Theme | Public URL |
|------|----------|-------|------------|
| `northline-tattoo` | Northline Tattoo | Classic | https://northline-tattoo.getbookking.com |
| `iron-district-gym` | Jordan Reyes (Iron District Gym) | Blade | https://iron-district-gym.getbookking.com |
| `studio-amara` | Studio Amara | Studio 12 | https://studio-amara.getbookking.com |
| `stone-cut-barbers` | Stone Cut Barbers | Stonecut | https://stone-cut-barbers.getbookking.com |
| `gilded-palm` | Maison Lumière | Luxe | https://gilded-palm.getbookking.com |

Staging: `https://test-app-96812.web.app/{slug}`

## Owner logins (internal)

| Email | Slug |
|-------|------|
| demo-northline@getbookking.com | northline-tattoo |
| demo-iron-district@getbookking.com | iron-district-gym |
| demo-studio-amara@getbookking.com | studio-amara |
| demo-stone-cut-barbers@getbookking.com | stone-cut-barbers |
| demo-gilded-palm@getbookking.com | gilded-palm |

Use owner accounts to upload photos and tweak copy in the app. Do not share passwords publicly.

## Colors & photos (seeded)

| Slug | Palette | Images |
|------|---------|--------|
| northline-tattoo | `warm-coral` (custom) | Custom hero + 8-gallery (see `scripts/assets/northline-tattoo/`) |
| iron-district-gym | `original` (Blade) | Custom hero + 8-gallery (see `scripts/assets/iron-district-gym/`) |
| studio-amara | `rose-quartz` (custom) | User nail set: hero + 6-gallery + philosophy + book CTA (`scripts/assets/studio-amara/`) |
| stone-cut-barbers | `barber-chocolate` (custom) | Custom hero + 9-gallery + about photo (see `scripts/assets/stone-cut-barbers/`) |
| gilded-palm | `terracotta-clay` (custom) | Custom hero + 10-gallery + 5 shop products (see `scripts/assets/gilded-palm/`) |

Re-run `node scripts/seed-demo-accounts.js` to refresh. Replace with your own uploads in Website Design anytime.

If Studio Amara gallery looks empty but hero still shows, restore nail photos from the saved featured strip:

```bash
node scripts/restore-studio-amara-images.js
```

Full image upload (hero + 6 gallery + philosophy + book CTA): see `upload-tenant-hero.js`, `upload-tenant-gallery.js`, `upload-tenant-studio12-images.js` and `scripts/assets/studio-amara/`.

## Marketing template previews

`web/marketing/templates.html` shows desktop screenshots from `web/marketing/assets/template-previews/`.

- **Classic** — exported from Figma ([Template Demos](https://www.figma.com/design/m3YpRrGJCUMrZukpCcnvFk/Get-Bookking-%E2%80%94-Template-Demos), node `26:2`).
- **Blade, Luxe, Studio 12, Stonecut** — captured from live demo tenants:

```bash
node scripts/capture-marketing-desktop-previews.mjs
```

Deploy marketing after updating previews:

```bash
firebase deploy --only hosting:marketing
```
