# Tap to Pay on iPhone

Tap to Pay entitlement is in **`Test/Test-Release.entitlements`** (Release builds only). Debug uses **`Test-Debug.entitlements`** (push only) so daily builds sign without the proximity-reader key until profiles are ready.

## Xcode setup

1. **Stripe Terminal SPM:** `https://github.com/stripe/stripe-terminal-ios` **4.7.3** (product **StripeTerminal** on the Test target).
2. **Compile flag:** `TAP_TO_PAY_ENABLED` in **Release** only. **Debug** omits it so Tap to Pay code is excluded while developing.
3. **Physical device:** iPhone XS or later, not iOS beta. Simulator cannot complete a real tap.
4. **Terminal location:** Created automatically per tenant when Tap to Pay enablement starts (`prepareTapToPayTermsAcceptance` / `ensureTapToPayTerminalLocation`). A Connect account can exist before `charges_enabled`; finishing Stripe KYC is **after** Apple T&C + education. Optional dev override: `TAP_TO_PAY_LOCATION_ID` in `Secrets.plist`.

### “Missing package product StripeTerminal”

The dependency is already in `Test.xcodeproj`. Xcode sometimes needs a fresh resolve:

```bash
./scripts/resolve-xcode-packages.sh
```

Or in Xcode: **File → Packages → Reset Package Caches**, then **Resolve Package Versions**, then **Clean Build Folder** (⇧⌘K) and build.

Keep **~5 GB+ free** on your boot drive so SPM can download.

## Backend

Cloud Functions (deploy from `functions/`):

- `createPaymentIntentForTapToPay`
- `createTerminalConnectionTokenForTapToPay`
- `ensureTapToPayTerminalLocation` — owner-only; creates `tml_…` on the Connect account if missing
- `prepareTapToPayTermsAcceptance` — Connect account + Terminal location so Apple T&C can run before Stripe KYC finishes
- `getConnectAccountStatus` — includes `terminalLocationId` when set

## App flow (Apple first, Stripe last)

1. **Hero** once for eligible users (and value-prop push).
2. User taps **Get started** / **Tap to Pay on iPhone**.
3. **Apple T&C** via Stripe Terminal reader connect (`tosAcceptancePermitted = true`). Does **not** require Stripe `charges_enabled`.
4. **Configuration progress** while the reader prepares.
5. **Merchant education** immediately after first T&C (Apple How to Tap on iOS 18+, else toolkit videos). Education closes without opening Stripe — merchant taps **Tap to Pay** again for Connect/checkout. Reopen under **Payment settings → Tap to Pay settings → How to use Tap to Pay** (visible even if Stripe setup is incomplete).
6. **Stripe Connect** onboarding in Safari on a subsequent Tap to Pay tap if not finished.
7. **Checkout** when charges are enabled.

- T&C is presented by Stripe/Apple when needed. `TapToPayReaderSession` keeps acceptance only for the current reader session; it never persists an app-local acceptance flag.
- Reader warms up when the app becomes active (signed in, terms accepted for this session, location configured).
- Checkout shows processing → approved / declined / timeout and an on-screen receipt sheet (share PDF / Messages).

## Partner launch email (Apple req 6.1)

Sent via **Resend** from `Get Bookking <beta@getbookking.com>` after successful signup provisioning (`provisionNewProviderFromWizard`).

- Template: Apple TTPoiP Email Launch copy (US-EN) with Get Bookking logo / CTA
- Module: `functions/tapToPayLaunchEmail.js`
- Assets (host on marketing site): `web/marketing/assets/brand/bookking-email-logo.png`, `ttpoi-email-launch-hero.jpg`
- Idempotent: `users.tapToPayLaunchEmailSentAt`
- Manual / test resend (owner): callable `sendTapToPayLaunchEmail` with `{ force: true }`

Requires `RESEND_API_KEY` (same as beta / password-reset mail). Deploy marketing assets before relying on image URLs in production.

## Apple review (still required)

See Apple’s [App Requirements and Review PDF](https://apple.ent.box.com/v/ttpoiappreviewpdf) for marketing launch assets and submission videos. Merchant education (post–T&C + Settings) is implemented in `TapToPayMerchantEducation.swift`.
