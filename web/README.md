# Client Booking Page

Client-facing booking page. URL format: `https://getbookking.com/{businessSlug}/book/{serviceSlug}` (same path shape on **localhost** / **\*.web.app** with that origin). Slugs are **case-insensitive** in the path and normalized to lowercase for lookups.

Production site: **https://getbookking.com** (Firebase project ID may still be `test-app-96812` for CLI deploys).

**Troubleshooting:** Tenant URLs must match the **`slug`** stored in Firestore (`tenants.slug`) exactly (letters/numbers/hyphens). After changing routing, run `firebase deploy --only hosting` so the CDN picks up `index.html`. `firebase.json` sets short cache for HTML routes and long cache for static assets.

## Setup

1. **Add a Web app in Firebase Console**
   - Go to [Firebase Console](https://console.firebase.google.com) → your project → Project Settings → Your apps
   - Click "Add app" → Web (</>)
   - Copy the `firebaseConfig` object and paste it into `js/firebase-config.js`

2. **Create Firestore data**
   - Add a `tenants` collection with documents containing: `slug`, `displayName`, `isActive`, `bookingModeDefault`, etc.
   - Optional branding fields on tenant: `logoUrl`, `primaryColor`, `primaryColorHover`, `secondaryColor`, `successColor`, `backgroundColor`, `fontFamily`
   - **Typography (display):** `heroFont` — `kanit` (default), `oswald`, `playfair`, `plus-jakarta-sans`, `teko`, `libre-baskerville`, `cormorant-garamond`. Loaded from Google Fonts in `index.html`; mirrored to legacy `headlineFont` on save from the app.
   - Add a `services` subcollection under each tenant with: `slug`, `name`, `durationMinutes`, `isActive`, `bookingModeOverride`, `formSchema`

3. **Update Firestore rules** for the `tenants` structure (see project root `firestore.rules` if present)

## Deploy

```bash
# Install Firebase CLI if needed: npm install -g firebase-tools
firebase login
firebase use test-app-96812   # or your project ID
firebase deploy --only hosting
```

To deploy Firestore rules as well: `firebase deploy`

## Local testing

Use a static server that supports SPA routing (e.g. `npx serve web` or Firebase emulator).
