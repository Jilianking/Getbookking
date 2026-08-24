<p align="center">
  <img
    src="web/marketing/assets/brand/logo-dark-128.png"
    alt="Get Bookking logo"
    width="96"
  >
</p>

<h1 align="center">Get Bookking</h1>

Get Bookking is a native iOS application and web platform for managing
business websites, bookings, schedules, clients, payments, team members,
and client communication.

## Project Status

Get Bookking is currently being tested through Apple TestFlight and remains
under active development.

Most application and backend systems are implemented. Feature availability
and billing behavior may differ from the eventual production release.

During TestFlight:

- SMS phone-number purchasing, provisioning, and refresh are disabled.
- Domain purchase and transfer are disabled.
- Demo accounts use seeded customers, bookings, messages, and payment activity.

## Repository Structure

| Path | Purpose |
|---|---|
| `Test/` | SwiftUI iOS application |
| `web/` | Public tenant websites and booking forms |
| `web/marketing/` | Signup, beta, account, and administrative pages |
| `functions/` | Firebase Functions and third-party integrations |
| `cloudflare/tenant-proxy/` | Tenant subdomain and custom-domain routing |
| `scripts/` | Development, migration, and demo-data utilities |
| `docs/` | Integration and implementation documentation |

## Implemented Systems

- Firebase Authentication and tenant-based accounts
- Firestore-backed bookings, clients, services, products, and teams
- Booking requests, approvals, calendar scheduling, and appointment history
- Charter scheduling and boat occupancy
- Customizable public websites and booking forms
- In-app website preview, Builder, and Quick Edit
- Stripe Connect payments, deposits, refunds, subscriptions, and reporting
- Stripe Terminal and Tap to Pay on iPhone
- Twilio client-messaging infrastructure
- Team roles, permissions, invitations, and payment workflows
- Firebase Hosting for tenant and account websites
- Cloudflare tenant and custom-domain routing
- TestFlight onboarding and beta administration
- Seeded demo accounts and activity

## Website Builder

The Design area loads the tenant website in a `WKWebView`. Builder mode
connects the SwiftUI editing interface to the website preview through an
injected JavaScript bridge.

Quick Edit supports:

- Inline website-copy editing
- Independent text, button, card, and section colors
- Font-size adjustments
- Image selection
- Template and palette changes
- Persisted tenant-specific overrides

Changes to Builder behavior commonly involve both the Swift files under
`Test/` and the template implementation in `web/index.html`.

## Technology

- **iOS:** Swift, SwiftUI, WebKit
- **Backend:** Firebase Authentication, Firestore, Cloud Functions, Storage
- **Web:** HTML, CSS, JavaScript, Firebase Hosting
- **Payments:** Stripe Connect, Stripe Terminal, Tap to Pay on iPhone
- **Messaging:** Twilio
- **Routing:** Cloudflare Workers
- **Domain integration:** Namecheap API
- **Shipping:** Shippo

## Local Development

### Requirements

- macOS with Xcode
- Node.js 22
- Firebase CLI
- Access to a configured Firebase project

### iOS

Open `Test.xcodeproj` and run the **Get Bookking** scheme.

The application requires:

- A valid `GoogleService-Info.plist`
- Local `Secrets.plist` configuration
- Access to the configured Firebase backend

### Cloud Functions

```bash
cd functions
npm install
npm run serve
```

See [`functions/README.md`](functions/README.md) for backend configuration
and service-specific setup.

### Web

The public booking experience is located in `web/`. Use Firebase Emulator
Suite or a static server that supports single-page application routing.

See [`web/README.md`](web/README.md) for web and Firestore setup.

## Documentation

- [Cloud Functions](functions/README.md)
- [Web booking](web/README.md)
- [Demo accounts](scripts/README-demo-accounts.md)
- [Cloudflare tenant proxy](cloudflare/tenant-proxy/README.md)
- [Tap to Pay](docs/TAP_TO_PAY.md)
- [Client texting](docs/TWILIO-CLIENT-TEXTING.md)
- [Push notifications](docs/PUSH_NOTIFICATIONS.md)
- [Shippo setup](docs/SHIPPO_SETUP.md)

## Development Notes

- Keep iOS and web changes together when behavior depends on the WebKit bridge.
- Deploy Firebase Hosting after changing production web templates.
- Deploy Firestore and Storage rules when their local definitions change.
- Do not commit credentials, environment files, or customer data.
