# Tap to Pay on iPhone (disabled)

Tap to Pay is **turned off** until Apple approves the proximity-reader entitlement.

## Re-enable when approved

1. Restore `Test/Test.entitlements`:
   ```xml
   <key>com.apple.developer.proximity-reader.payment.acceptance</key>
   <true/>
   ```
2. In Xcode: **File → Add Package Dependencies** → `https://github.com/stripe/stripe-terminal-ios` → add **StripeTerminal** to the Test target.
3. Target **Test** → **Build Settings** → **Active Compilation Conditions** → add `TAP_TO_PAY_ENABLED` for Debug and Release.
4. Clean build folder and build on a physical device.

Cloud Functions (`createPaymentIntentForTapToPay`, `createTerminalConnectionTokenForTapToPay`) are unchanged and ready when the app side is re-enabled.
