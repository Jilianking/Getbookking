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

## Functions

- **createConnectAccountLink** (callable): Creates a Stripe Connect account (if needed) and returns an Account Link URL for onboarding. The iOS app opens this URL in Safari.
