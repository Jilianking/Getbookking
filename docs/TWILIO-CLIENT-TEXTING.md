# Client texting (Twilio)

## Product rules

- **Monthly cap**: 1,000 SMS per tenant per calendar month (**UTC**), **inbound + outbound** combined (`smsUsagePeriod`, `smsUsageCount` on tenant). STOP/HELP/START auto-replies are not logged toward the cap.
- **30-day free trial**: no client SMS, no phone number provisioning.
- **Paid subscription** (`active` in Stripe): owner may enable client texting (opt-in).
- **Mid-trial upgrade**: Account settings or Notifications → **Start subscription today** ends trial and charges the card.
- Each business gets a **US local number on the master Twilio account**, added to the **shared 10DLC messaging service** (not a subaccount per tenant).

## Setup

1. Create a Twilio account and register **10DLC** for transactional messaging (platform brand).
2. Note the **Messaging Service SID** (`MG…`) tied to your **approved** US A2P campaign.
3. Set Twilio credentials (secrets) and master messaging service (param):
   ```bash
   firebase functions:secrets:set TWILIO_ACCOUNT_SID
   firebase functions:secrets:set TWILIO_AUTH_TOKEN
   ```
   Add to `functions/.env.test-app-96812` (or Firebase Console → Functions → parameter):
   ```
   MASTER_TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
4. Deploy functions including `twilioInboundSms`, `onTenantSmsProvisionRequested`, `onTenantBookingRequestSms`.
5. Point inbound SMS webhooks to:
   `https://us-central1-test-app-96812.cloudfunctions.net/twilioInboundSms`
   (Provisioning sets this URL on each purchased number.)

## Firebase status (`test-app-96812`)

- Secrets `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set in Secret Manager.
- Set `MASTER_TWILIO_MESSAGING_SERVICE_SID` in `functions/.env.test-app-96812` to your approved campaign messaging service before enabling new tenants.
- Twilio functions are deployed (including `sendClientSms` for in-app Messages).

## Cloud Functions

| Function | Purpose |
|---|---|
| `syncTenantBillingFromStripe` | Owner: link `stripeCustomerId` / subscription from Stripe email and sync `subscriptionStatus` |
| `startSubscriptionToday` | End trial, charge now (`active`); auto-links Stripe if ids missing |
| `requestTenantSmsProvisioning` | Opt-in; sets `smsStatus: pending` |
| `sendClientSms` | Team sends SMS from Messages / client thread |
| `onTenantSmsProvisionRequested` | Buys master number + attaches to master MG |
| `onTenantBookingRequestSms` | SMS on confirm/decline |
| `twilioInboundSms` | STOP/HELP + inbound log |

## Firestore (`tenants/{id}`)

- `smsEnabled`, `smsStatus`, `smsPhoneNumber`, `smsPhoneNumberSid`, `twilioMessagingServiceSid`, `subscriptionStatus`
- Legacy `twilioSubaccountSid` is removed on provision/send
- `tenants/{id}/smsThreads`, `tenants/{id}/smsLog`, `tenants/{id}/smsOptOuts`
- **Rules:** team members with `canManageTenant` may **read** `smsThreads` / `smsLog` (writes are Cloud Functions only).

## Migrating tenants (subaccount → master MG)

Tenants provisioned under the old subaccount model may see **30034** until re-provisioned.

1. Set `MASTER_TWILIO_MESSAGING_SERVICE_SID` and deploy functions.
2. Owner calls `requestTenantSmsProvisioning` with `{ smsConsentAccepted: true, forceReprovision: true }` (or toggle texting off/on in app if you wire that flag).
3. A new master number is purchased if the old number is not on the master account; release old subaccount numbers in Twilio console when done.

## Sign-up

Subscriptions are created only after **Stripe Checkout** on `signup.html` (`createProviderSubscriptionCheckout` → webhook / `completeProviderSubscriptionCheckout`). Firebase Auth alone does not create a Stripe subscription.

## Stripe as source of truth

| Callable | Purpose |
|---|---|
| `createBillingPortalSession` | Stripe Customer Portal (card, plan, cancel, invoices) |
| `syncTenantBillingFromStripe` | Pull customer/subscription/status/plan into Firestore |
| `stripeSubscriptionWebhook` | Auto-sync on `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed` |

**Stripe Dashboard:** enable Customer portal; webhook → `stripeSubscriptionWebhook` with signing secret `STRIPE_WEBHOOK_SECRET`. Use **Test** mode with test API keys.

Portal return URL: `…/account.html?billing=portal` (web auto-runs sync).

## iOS

**Settings → Account** or **Team → Notifications**:

- **Manage billing in Stripe** — Customer Portal (syncs when you return to the app)
- **Sync billing from Stripe** — manual pull from Stripe API
- **Start subscription today** — end trial (messaging unlocks when status is `active`)

**Client texting** (Team → Notifications): enable after paid subscription.

**Refresh texting number** (iOS, when active): calls `requestTenantSmsProvisioning` with `forceReprovision: true` to buy a master-account number and attach it to the shared 10DLC messaging service (fixes subaccount / 21606 errors).
