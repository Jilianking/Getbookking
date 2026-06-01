# Push notifications (APNs + FCM)

## What was integrated

1. **iOS (`PushNotificationManager.swift`)**  
   - Requests alert/badge/sound permission on launch.  
   - Registers with APNs and receives the **FCM token** via `MessagingDelegate`.  
   - Saves tokens to Firestore: `users/{uid}/deviceTokens/{sha256(token)}` with `token`, `platform: ios`, `updatedAt`.  
   - On sign-out, deletes the device doc (when possible) and calls `Messaging.messaging().deleteToken()`.

2. **Xcode**  
   - **FirebaseMessaging** Swift package product linked on the Test target.  
   - **`Test/Test-Debug.entitlements`** — `aps-environment` = `development` (Debug builds).  
   - **`Test/Test-Release.entitlements`** — `aps-environment` = `production` (Release / Archive).  
   - **`INFOPLIST_KEY_UIBackgroundModes`** = `remote-notification`.

3. **Cloud Function `onTenantBookingRequestCreated`** (`functions/index.js`)  
   - Triggers on `tenants/{tenantId}/bookingRequests/{requestId}` **onCreate**.  
   - Finds users with `tenantId` matching that tenant, collects all `deviceTokens`, sends **FCM multicast** with title/body + `data`: `type`, `tenantId`, `requestId`.

## What you must do in Firebase / Apple

1. **Apple Developer**  
   - App ID: enable **Push Notifications**.  
   - Create an **APNs Authentication Key** (.p8).

2. **Firebase Console**  
   - Project settings → **Cloud Messaging** → **Apple app configuration** → upload the **APNs key** (and Team ID, Key ID, etc.).

3. **Deploy functions**  
   ```bash
   cd functions && npm install && firebase deploy --only functions:onTenantBookingRequestCreated
   ```
   (Or deploy all functions.)

4. **Firestore security rules**  
   - Allow each signed-in user to **write only their own** `users/{uid}/deviceTokens/{docId}` (and **read** if you need it only from Cloud Functions, Functions use Admin SDK and bypass rules).

5. **Production builds**  
   - For TestFlight/App Store, ensure **`aps-environment`** is **production** in the archived app (Xcode usually sets this when signing with a **distribution** profile). You may duplicate build configurations or use a Release entitlement file if needed.

## Simulator note

Push delivery is **limited** on the simulator; test on a **physical device** for real APNs behavior.
