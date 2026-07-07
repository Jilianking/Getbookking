# Tap to Pay on iPhone

Tap to Pay entitlement is in **`Test/Test-Release.entitlements`** (Release builds only). Debug uses **`Test-Debug.entitlements`** (push only) so daily builds sign without the proximity-reader key until profiles are ready.

## Xcode setup

1. **Stripe Terminal SPM:** `https://github.com/stripe/stripe-terminal-ios` **4.7.3** (product **StripeTerminal** on the Test target).
2. **Compile flag:** `TAP_TO_PAY_ENABLED` in **Release** only. **Debug** omits it so Tap to Pay code is excluded while developing.
3. **Physical device:** iPhone XS or later, not iOS beta. Simulator cannot complete a real tap.
4. **Terminal location:** Created automatically per tenant when the owner opens Tap to Pay (stored as `tenants.stripeTerminalLocationId`). Requires Stripe Connect with `charges_enabled` and a business address in **Website Design** (`contactAddress` / `serviceArea`). Optional dev override: `TAP_TO_PAY_LOCATION_ID` in `Secrets.plist`.

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
- `getConnectAccountStatus` — includes `terminalLocationId` when set

## App flow

- **Payments** → **Tap to Pay** (always tappable; routes to Stripe Connect or checkout).
- **First tap:** Apple Tap to Pay Terms & Conditions (via Stripe Terminal reader connect) **before** Stripe Connect onboarding in Safari.
- **After T&C (first time):** Merchant education — Apple “How to Tap” overlay on iOS 18+, or in-app pages on older iOS. Reopen anytime under **Payments → Tap to Pay settings → How to use Tap to Pay**.
- T&C is shown once per device; `TapToPayReaderSession` persists acceptance locally.
- Reader warms up when the app becomes active (signed in, Stripe connected, location configured).
- Checkout shows processing → approved / declined / timeout and optional share receipt.

## Backend (Tap to Pay terms)

- `prepareTapToPayTermsAcceptance` — creates Connect account + Terminal location without `charges_enabled`; iOS connects reader for Apple T&C.
- `createTerminalConnectionTokenForTapToPay` — ensures Connect account exists before issuing token.

## Apple review (still required)

See Apple’s [App Requirements and Review PDF](https://apple.ent.box.com/v/ttpoiappreviewpdf) for marketing launch assets and submission videos. Merchant education (post–T&C + Settings) is implemented in `TapToPayMerchantEducation.swift`.
