# Get Bookking

Native iOS app and web stack for **Get Bookking** — business owners manage branding, booking pages, clients, and site design; clients book via the public site at [getbookking.com](https://getbookking.com).

| Area | Path | Notes |
|------|------|--------|
| iOS app | `Test/` (target **Get Bookking**) | SwiftUI, Firebase, WKWebView site preview |
| Public site | `web/` | Single-page tenant sites (`index.html`) |
| Cloud Functions | `functions/` | Booking, Stripe, Twilio, etc. |
| Tenant proxy | `cloudflare/tenant-proxy/` | Optional edge routing |

Open **`Test.xcodeproj`** in Xcode and run the **Get Bookking** scheme.

---

## Design → Builder & Quick Edit

**Design** loads the live site in a `WKWebView`. With **Builder** on, **Quick Edit** overlays touch-friendly editing on the preview.

### Bottom chrome (slim toolbar)

- Collapse chevron → floating save FAB when collapsed
- **Text** color well (shows computed color of focused text when editing)
- Font stepper (− / size / +) when the field supports size — no field title label
- **Save** (checkmark) — commits inline text and dirty colors

Section chips, “Editing: …”, and separate Hero/Button wells were removed; colors are chosen by **tapping the preview**.

### Tap rules (preview)

| Tap target | Result |
|------------|--------|
| Blue dashed box on **words** | Inline **text** edit + **Text** swatch |
| Blue box on **button labels** | Text/button color (role-aware) |
| **Open grey** inside hero (not on copy) | **Hero** color sheet |
| **Hero photo column** (right on Blade/Classic/etc.) | Image picker; **long-press** photo for Hero color |
| Other `data-bk-color-surface` bands | Band color (page, card, featured, about) |

**Blade / Classic / Stonecut:** Hero band color = **page background** (`backgroundColorHex`).  
**Luxe / Studio 12:** Hero band color = **hero image slot** tint (`previewHeroSlotColorHex`).

**Rule of thumb:** boxed copy = text; open hero grey = background (with photo-column exception above).

### Key iOS files

| File | Role |
|------|------|
| `Test/DesignView.swift` | Builder toggle, preview URL, Quick Edit bridge |
| `Test/PreviewQuickEditChrome.swift` | Bottom toolbar, color sheets, throttled patches |
| `Test/WebViewPreview.swift` | Injected Quick Edit JS/CSS, touch routing |
| `Test/PreviewColorSurface.swift` | Hero/page/card/featured/about → tenant color fields |
| `Test/QuickEditFieldTitles.swift` | Field labels (chrome no longer shows title row) |

### Key web files

| File | Role |
|------|------|
| `web/index.html` | Templates, `data-edit-key`, `data-bk-color-surface`, `bk-hero-band-hit`, `applyPreviewColorPatch` |
| `web/README.md` | Hosting deploy & Firestore tenant setup |

Preview color updates use `window.__bkApplyPreviewColorPatch` (fast CSS-vars path while dragging; full band pass on sheet **Done** or save).

---

## Web preview in the app

- Preview URL: tenant `bookingUrl` + `_cb` reload token (`DesignViewModel.webPreviewReloadToken`).
- After editing **`web/index.html`**, rebuild the iOS app **and** deploy hosting if you test against production CDN HTML.

```bash
firebase deploy --only hosting
```

See `web/README.md` for Firebase config and tenant fields.

---

## Cloud Functions

```bash
cd functions
npm install
firebase deploy --only functions
```

See `functions/README.md` for secrets (Stripe, Twilio, etc.).

---

## Git / contributions

- Do not commit secrets (`.env`, API keys, `js/firebase-config.js` with real keys).
- Quick Edit changes often touch **both** `Test/Test/*.swift` and `web/index.html` — include both in the same PR when behavior depends on injected JS.
