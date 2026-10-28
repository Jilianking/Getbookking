# Plan: booking balances, collecting them, and reminders

Status: **planned, not started** (saved 2026-10-27). Build after the Apple resubmission and the Stripe live switch.

## Why

A booking can be paid in parts: a deposit online, then the rest later. Today the server saves what was paid
(`paidCents`, and for charters `tripCents`, `addonCents`, `depositPartCents`, `balanceDueCents`), but the app
never shows it and there is no way to collect the rest from the booking. Captains and artists have to work out
the balance themselves and take it separately.

## What already exists to build on

- In-app card checkout and Tap to Pay (`ManualPaymentSheetPresenter`, Tap to Pay flow).
- Payment links: `createDepositLink` makes a PaymentIntent and a `https://<shop>/pay?pi=…` link.
- Client texting (Twilio) and email (Resend, `notifyOwnerAboutAccount` pattern).
- Scheduled jobs (`pubsub.schedule`, e.g. `expireCharterPaymentHolds`).
- Charter checkout already records trip, add-ons, deposit and balance on the booking, and payment metadata
  (`customerName`, `serviceLabel`, `serviceCents`, `addonsLabel`, `addonCents`) that the app shows as separate
  lines on transactions and receipts.

## How it differs by business type

|                  | Charters                         | Studios, salons, barbers                                  |
|------------------|----------------------------------|-----------------------------------------------------------|
| Deposit taken    | At online checkout               | Online checkout, or a deposit link after approving        |
| Balance due      | Before departure                 | At the appointment (or before, if the shop chooses)       |
| Price            | Trip price + add-ons             | Service price, often changes (tattoo quotes, extra time)  |
| Who gets paid    | Captain                          | Owner, or the assigned artist on teams (studio share)     |

## Phase 1: Payment section on every booking (app + server)

```
PAYMENT
Price                    $500   [Edit]
Add-ons (Bait)            $10
Paid Oct 27 · card        $60
Paid Oct 30 · cash       $200
─────────────────────────────────
Balance due              $250

[ Collect ]  [ Text pay link ]  [ Mark paid in cash ]
```

- Edit price: for quotes and final prices; the balance updates.
- Collect: Tap to Pay or card in the app, amount and client filled in. Teams: goes to the assigned artist with
  studio share, same as other payments.
- Text pay link: secure link to pay on the shop's site; copy-link if the shop has no texting number.
- Mark paid in cash: editable amount; partial payments leave the rest due.
- "Paid in full ✓" once nothing is owed.
- Calendar: small "$250 due" tag on bookings with money owed.
- Transactions and receipts: label balance payments "<service> balance" with the client's name.
- Booking keeps a list of payments (card, link, cash) instead of a single `paidCents`.
- Cancel and refund must refund every card payment on the booking, not only the first. Cash is never
  auto-refunded; the app reminds the owner to return it.

## Phase 2: Balance reminders

- Daily scheduled job sends the guest a text (if the shop has texting) and an email.
  - Charters: "Your $450 balance for Half-day charter on Tue, Oct 27 is due before departure. Pay here: [link]"
  - Shops: "Reminder: your appointment at Bleu's Tattoos is Fri at 2 PM. Balance due: $250. Pay ahead here:
    [link], or pay at your appointment."
- Sent once; never if the balance is paid or the booking is cancelled.
- Email sender: "<Business> via Get Bookking", replies go to the shop's email.

## Phase 3: Settings (Booking settings → "Payments & balance")

- Balance due: Before the trip/appointment / At the appointment. Defaults: charters before, shops at.
- Ways guests can pay the balance: Payment link on/off, Cash on/off (card and Tap to Pay always on).
- Balance reminder: Off / 1 day / 2 days / 3 days / 1 week before. Defaults: charters 2 days, shops 1 day.
- Deposits on cancellation: Refundable / Non-refundable (default Refundable, so nothing changes today).

## Open decisions

1. Add the Refundable / Non-refundable deposit setting? (Recommended, default Refundable.)
2. Tips when paying the balance? (Suggested for a later phase.)
3. Teams: balance collected by an artist goes to that artist with studio share applied?
4. Build order: Phase 1 → 2 → 3, testing each on a charter shop (test9001) and a tattoo shop.

## How to test

- Stripe test mode, card 4242 4242 4242 4242, on test9001 (charter, deposit mode) and a tattoo test shop.
- Book with a deposit, then: collect the balance with Tap to Pay; send a pay link and pay it; mark cash
  (full and partial); cancel and check both card payments are refunded.
- Reminders: a script or admin trigger to run the reminder job now for one booking, instead of waiting a day.

## Rough size

Phase 1 is the biggest (booking payment list, app section, three collect paths, refunds): about a day with
testing. Phase 2 and 3: a few hours each.
