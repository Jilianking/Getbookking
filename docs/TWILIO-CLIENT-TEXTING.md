# Client texting (Twilio)

## Product rules

- **30-day free trial**: no client SMS, no phone number provisioning.
- **Paid subscription** (`active` in Stripe): owner may enable client texting (opt-in).
- **Mid-trial upgrade**: Account settings or Notifications → **Start subscription today** ends trial and charges the card.
- Each business gets a **Twilio subaccount + local number** when they enable texting (not at signup).

## Setup

1. Create a Twilio account and register **10DLC** for transactional messaging (platform brand).
2. Set Firebase secrets:
   ```bash
   firebase functions:secrets:set TWILIO_ACCOUNT_SID
   firebase functions:secrets:set TWILIO_AUTH_TOKEN
   ```
3. Deploy functions including `twilioInboundSms`, `onTenantSmsProvisionRequested`, `onTenantBookingRequestSms`.
4. Point inbound SMS webhooks to:
   `https://us-central1-<PROJECT_ID>.cloudfunctions.net/twilioInboundSms`

## Cloud Functions

| Function | Purpose |
|---|---|
| `startSubscriptionToday` | End trial, charge now (`active`) |
| `requestTenantSmsProvisioning` | Opt-in; sets `smsStatus: pending` |
| `onTenantSmsProvisionRequested` | Buys subaccount + number |
| `onTenantBookingRequestSms` | SMS on confirm/decline |
| `twilioInboundSms` | STOP/HELP + inbound log |

## Firestore (`tenants/{id}`)

- `smsEnabled`, `smsStatus`, `smsPhoneNumber`, `twilioSubaccountSid`, `subscriptionStatus`
- `tenants/{id}/smsLog`, `tenants/{id}/smsOptOuts`

## iOS

Team settings → Notifications → **Client texting**
