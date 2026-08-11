# Shippo shop shipping setup

Bookking uses **Shippo for live rates only** at `/shop/checkout`. Customers pay the selected rate to the studio. **Bookking never buys shipping labels** — the studio buys postage themselves (post office, Pirate Ship, etc.) using the shipping money collected.

## Rate origin vs drop-off

- **Quotes** always use the studio **business contact address / ZIP** (Design → Contact).
- **Where to drop off** in the app is optional (nearby USPS/UPS lookup). It is saved for the studio only and **does not** change quotes.

## 1. Create a Shippo account

1. Sign up at [Shippo](https://apps.goshippo.com/) → **I don’t have a store**
2. Open **API** / developer settings
3. Copy a **test** token (`shippo_test_…`) while building

## 2. Set the Cloud Functions secret

```bash
cd /path/to/Test
firebase functions:secrets:set SHIPPO_API_TOKEN
# paste shippo_test_… or live token
```

Then deploy functions that use the secret:

```bash
firebase deploy --only functions:getShopShippingRates,functions:createShopCheckoutPayment,functions:finalizeShopOrderPayment
```

Or full functions deploy after the secret exists.

## 3. Enable in the app

**Shop → Shipping & pickup**:

- Turn on **Shipping (live carrier quotes)** and/or **Local pickup**
- Confirm business address under Design → Contact (used for quotes)
- Set **Default package** weight (**oz**) and **L×W×H** (**in**) as a fallback
- Set weight/dims on each product when possible
- Optionally save a nearby drop-off spot (reminder only)

## 4. Checkout flow

- **Pickup** — free, no Shippo call  
- **Ship** — customer address → live rates → pays product + shipping  
- After payment: `shippingLabelMode: studio_manual` — no platform label purchase

Your platform **1%** still applies on the full charged amount (including shipping).

## Notes

- Platform `SHIPPO_API_TOKEN` is used **only** to fetch/validate rates — not to buy postage  
- Until the secret is set, enabling shipping will error when requesting rates; pickup still works once shop callables are deployed with the secret declared
