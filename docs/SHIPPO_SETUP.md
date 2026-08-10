# Shippo shop shipping setup

Bookking uses **Shippo** for live USPS/UPS (etc.) rates at `/shop/checkout`. Customers pay the selected rate; after payment, Functions buy the label (best-effort).

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

**Shop → Shipping & pickup** (or Website Builder → Shop settings):

- Turn on **Shipping (Shippo live rates)**
- Optionally fill **Ship from** (else business contact address is used)
- Set **Default package** weight/size
- On each product, set **Weight (oz)** and dimensions for accurate quotes

## 4. Checkout flow

- **Pickup** (default when enabled) — free, no Shippo call  
- **Ship** — customer enters address → **Get shipping rates** → picks a rate → pays product + shipping + fees  

Your platform **1%** still applies on the full charged amount (including shipping).

## Notes

- No Shippo subscription required for API Starter / pay-as-you-go  
- Postage is paid by the customer; label purchase uses the Shippo account wallet / carriers  
- Until `SHIPPO_API_TOKEN` is set, enabling shipping will error when requesting rates — pickup still works once Functions are deployed with a valid secret for shop callables that declare the secret
