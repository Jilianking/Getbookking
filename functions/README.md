# Cloud Functions for GetBookKing

## Setup

1. **Install dependencies** (already done): `npm install`

2. **Set Stripe secret key** (run in project root):
   ```bash
   firebase functions:secrets:set STRIPE_SECRET_KEY
   ```
   Paste your Stripe secret key when prompted (e.g. `sk_test_...` for test mode)

3. **Deploy**: `firebase deploy --only functions`

## Functions

- **createConnectAccountLink** (callable): Creates a Stripe Connect account (if needed) and returns an Account Link URL for onboarding. The iOS app opens this URL in Safari.
