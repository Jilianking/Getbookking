#!/usr/bin/env bash
# Resolves Swift packages (Firebase + Stripe Terminal) for the Test app.
# Run this if Xcode shows "Missing package product 'StripeTerminal'".
set -euo pipefail
cd "$(dirname "$0")/.."
echo "Resolving packages for Test…"
xcodebuild -scheme Test -resolvePackageDependencies
echo "Done. Quit and reopen Xcode, then Product → Clean Build Folder → Build."
