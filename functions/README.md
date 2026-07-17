# Cloud Functions for Get Bookking

## Setup

1. **Install dependencies** (already done): `npm install`

2. **Set Stripe secret key** (run in project root):
   ```bash
   firebase functions:secrets:set STRIPE_SECRET_KEY
   ```
   Paste your Stripe secret key when prompted (e.g. `sk_test_...` for test mode)

3. **Set subscription price IDs secret** (JSON map `solo` / `studio` / `shop` → Stripe Price id). Example for the Get Bookking test products is committed as `stripe-subscription-price-ids.example.json` (copy price IDs from Stripe if yours differ). Paste the one-line JSON when prompted, or pipe the file:
   ```bash
   firebase functions:secrets:set STRIPE_SUBSCRIPTION_PRICE_IDS --project test-app-96812 < functions/stripe-subscription-price-ids.example.json
   ```
   Hand-typing price ids can mix up `I` vs `l`; prefer copy from Stripe or this file.

4. **Optional — publishable key for marketing signup** (lets `signup.html` load Stripe without putting `pk_…` in static hosting): set the string param **`STRIPE_PUBLISHABLE_KEY`** (e.g. in `functions/.env` as `STRIPE_PUBLISHABLE_KEY=pk_test_…`, or via Firebase/Google Cloud params for the function). The callable `createProviderSubscriptionCheckout` returns it as `publishableKey` when set.

5. **Deploy**: `firebase deploy --only functions`

6. **Seed Stripe test subscriptions** (optional, for dashboard / MRR experiments):
   ```bash
   cd ..   # from functions/ to Test/
   STRIPE_SECRET_KEY=sk_test_... node scripts/seed-stripe-subscriptions.js --count=50 --with-connect-fees
   ```
   Creates Firebase Auth + Firestore tenants, **backdated paid subscriptions** (default 3 months), and **30 Connect customer payments per tenant** with the 1% platform application fee. Options: `--member-months=3`, `--payments-per-tenant=30`, `--force-payments` (add more Connect charges to existing seeds). Requires `firebase login` and test-mode keys.

7. **Twilio client texting** (optional):
   ```bash
   firebase functions:secrets:set TWILIO_ACCOUNT_SID
   firebase functions:secrets:set TWILIO_AUTH_TOKEN
   ```
   Configure inbound webhook in Twilio Console (or per-number SMS URL) to:
   `https://us-central1-<PROJECT_ID>.cloudfunctions.net/twilioInboundSms`

   Rules: **30-day free trial has no SMS**. Owner must **start paid subscription** (`active`), then **opt in** under Team settings → Notifications → Enable client texting.

8. **Beta admin portal** (`web/marketing/admin/`):
   - Set **`BETA_ADMIN_UIDS`** in `functions/.env` to your Firebase Auth uid(s), comma-separated.
   - Optional email (Resend): **`RESEND_API_KEY`**, **`BETA_EMAIL_FROM`** (outbound From), **`BETA_SUPPORT_EMAIL`** (Reply-To; default **`support@getbookking.com`** via admin settings).
   - Tap to Pay partner launch email (Apple 6.1): same Resend vars; auto-sent after signup provision; callable **`sendTapToPayLaunchEmail`** for owner test/resend (`force: true`).
   - Optional: **`MARKETING_ORIGIN`** (default `https://getbookking.com`) for onboarding links in approval emails.
   - Deploy functions + hosting (`marketing` target), then open `…/admin/requests.html` and sign in with an allowed account.
   - Firestore indexes: deploy with `firebase deploy --only firestore:indexes` if queries prompt for new indexes.

## Functions

- **createConnectAccountLink** (callable): Creates a Stripe Connect account (if needed) and returns an Account Link URL for onboarding. The iOS app opens this URL in Safari.
- **createTerminalConnectionTokenForTapToPay** (callable): Returns a Stripe Terminal ConnectionToken secret used by the iOS Tap to Pay flow.
- **prepareTapToPayTermsAcceptance** (callable): Ensures Connect account + Terminal location so iOS can show Apple Tap to Pay T&C before Stripe onboarding.

### Platform fee (customer payments)

A **1%** Connect application fee (`PLATFORM_FEE_BPS = 100` in `index.js`) is collected on:

- **createDepositLink** — customer deposit payment links
- **createPaymentIntentForTapToPay** — in-person Tap to Pay

It is **not** applied to provider subscription Checkout (`createProviderSubscriptionCheckout`). The customer pays the listed amount; the fee is deducted from the provider’s side (minimum 1¢ per charge). Refunds use `refund_application_fee: true`.

### Beta program

- **submitBetaWaitlist** (public callable): Marketing `testflight.html` signups → `betaWaitlist`.
- **Seed beta waitlist** (optional, for admin portal testing):
  ```bash
  cd ..   # from functions/ to Test/
  node scripts/seed-beta-waitlist.js --count=12
  node scripts/seed-beta-waitlist.js --email=you@example.com
  ```
  Submits via the same `submitBetaWaitlist` callable as `testflight.html` (emails like `beta-seed-001@example.com`, or `--email` for one custom entry). Options: `--prefix=beta-demo`, `--emulator`, `--first-name`, `--last-name`, `--plan`, `--team-size`, `--business-name`, `--business-type`.
- **getBetaAdminDashboard**, **listBetaWaitlist**, **approveBetaRequest**, **declineBetaRequest**, **inviteBetaTesterManual** (admin): Beta requests portal.
- **publishBetaWeeklyReport**, **listBetaReports**, **listBetaBugReports**, **updateBetaBugReport** (admin): Weekly reports + bug triage.
- **validateBetaOnboardingToken**, **completeBetaOnboarding** (public/tester): `admin/welcome.html` temp password → new password flow.
- **getBetaTesterPortal**, **submitBetaBugReport** (beta testers): `beta/index.html`.

